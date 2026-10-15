import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { Job, OutputFile } from '@queuepilot/shared';
import { backoffDelaySeconds, isFinalAttempt } from '../lib/backoff.js';
import { decideClaim } from '../lib/claim.js';
import { getConfig } from '../lib/config.js';
import { NonRetryableJobError, errorCode, errorMessage } from '../lib/errors.js';
import * as repo from '../lib/jobsRepo.js';
import { logger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { emitMetric } from '../lib/metrics.js';
import { delayRedelivery, parseJobMessage } from '../lib/queue.js';
import { getObjectBytes, isNotFound, putObject } from '../lib/storage.js';
import { applyFaultInjection } from '../processors/faultInjection.js';
import { runProcessor } from '../processors/index.js';

/**
 * SQS-triggered worker.
 *
 * Lambda receives up to 5 messages per invocation. Messages are processed one at a time and
 * the function returns `batchItemFailures` (partial batch response): only the failed messages
 * go back to the queue, successful ones are deleted by Lambda.
 */

export type RecordOutcome = 'done' | 'retry';

export interface WorkerDeps {
  remainingMs: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function processRecord(record: SQSRecord, deps: WorkerDeps, baseLog: Logger = logger): Promise<RecordOutcome> {
  const cfg = getConfig();
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? 1);
  const msg = parseJobMessage(record.body);
  const log = baseLog.child({ fn: 'worker', messageId: record.messageId, receiveCount, jobId: msg?.jobId, dispatchId: msg?.dispatchId });

  if (!msg) {
    // Unreadable message: fail it so that, after maxReceiveCount attempts, SQS parks it in the DLQ for inspection.
    log.error('unparseable message body; leaving it for the DLQ', { body: record.body.slice(0, 200) });
    return 'retry';
  }

  // ---- 1. Decide whether this message should be processed (duplicate / stale protection) ----
  const now = deps.now();
  const current = await repo.getJob(msg.jobId);
  const decision = decideClaim(current, msg.dispatchId, now);

  if (decision.action === 'discard') {
    log.info('message discarded', { reason: decision.reason });
    if (current && decision.reason === 'stale') {
      emitMetric('StaleMessagesDiscarded', 1);
      await repo.addEvent(msg.jobId, {
        at: now.toISOString(),
        event: 'STALE_MESSAGE_DISCARDED',
        message: 'An outdated message for this job was received (the job was re-dispatched since). It was safely ignored.',
        dispatchId: msg.dispatchId,
      });
    } else if (current && decision.reason === 'already-finished') {
      await repo.addEvent(msg.jobId, {
        at: now.toISOString(),
        event: 'DUPLICATE_DISCARDED',
        message: `A duplicate delivery arrived after the job finished (${current.status}). It was safely ignored.`,
        dispatchId: msg.dispatchId,
      });
    }
    return 'done';
  }
  if (decision.action === 'defer') {
    log.info('job is being processed by another invocation; deferring duplicate', { delaySeconds: decision.delaySeconds });
    await delayRedelivery(record.receiptHandle, Math.min(decision.delaySeconds, 900)).catch((err) => log.warn('could not defer', { err }));
    return 'retry';
  }

  // ---- 2. Claim the job (conditional update: only one worker can win) ----
  const job = current!;
  const attempt = decision.cycleAttempt;
  const startedAt = now.toISOString();
  const leaseUntil = new Date(now.getTime() + cfg.leaseSeconds * 1000).toISOString();
  const claimed = await repo.transitionJob(
    job.jobId,
    { status: job.status, dispatchId: job.dispatchId, leaseExpiredBefore: job.status === 'PROCESSING' ? startedAt : undefined },
    { status: 'PROCESSING', cycleAttempts: attempt, totalAttempts: job.totalAttempts + 1, leaseUntil, startedAt, updatedAt: startedAt },
    ['nextAttemptAt'],
  );
  if (!claimed) {
    log.info('lost the claim race; another invocation owns this job');
    return 'done';
  }
  const jlog = log.child({ attempt, type: job.type });
  if (decision.previousAttemptAbandoned) {
    await repo.addEvent(job.jobId, {
      at: startedAt,
      event: 'ATTEMPT_FAILED',
      attempt: attempt - 1,
      message: `Attempt ${attempt - 1} did not finish (the Lambda invocation timed out or crashed). SQS redelivered the message.`,
      dispatchId: job.dispatchId,
    });
  }
  if (decision.redriven) {
    await repo.addEvent(job.jobId, {
      at: startedAt,
      event: 'REDRIVEN',
      message: 'Message was moved back from the dead-letter queue (DLQ redrive). Starting a new attempt cycle.',
      dispatchId: job.dispatchId,
    });
  }
  await repo.addEvent(job.jobId, {
    at: startedAt,
    event: 'STARTED',
    attempt,
    message: `Attempt ${attempt} of ${cfg.maxAttempts} started (SQS receive count ${receiveCount}).`,
    dispatchId: job.dispatchId,
  });
  jlog.info('attempt started');

  // ---- 3. Do the work ----
  try {
    await applyFaultInjection(job.failMode, attempt, {
      remainingMs: deps.remainingMs,
      sleep: deps.sleep,
      log: (m, e) => jlog.warn(m, e),
    });

    let input: Uint8Array;
    try {
      input = await getObjectBytes(job.inputKey);
    } catch (err) {
      if (isNotFound(err)) throw new NonRetryableJobError('The input file no longer exists in S3.', 'INPUT_MISSING');
      throw err; // S3 hiccup: retryable
    }

    const result = runProcessor(job.type, input, job.fileName, job.params);
    const outputs: OutputFile[] = [];
    for (const f of result.files) {
      const key = `outputs/${job.jobId}/${f.name}`;
      await putObject(key, f.body, f.contentType);
      outputs.push({ name: f.name, key, contentType: f.contentType, sizeBytes: Buffer.byteLength(f.body) });
    }

    const finishedAt = deps.now().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const done = await repo.transitionJob(
      job.jobId,
      { status: 'PROCESSING', dispatchId: job.dispatchId },
      { status: 'SUCCEEDED', outputs, resultSummary: result.summary, finishedAt, durationMs, updatedAt: finishedAt },
      ['leaseUntil', 'lastError'],
    );
    if (!done) {
      jlog.warn('job changed during processing; result not recorded');
      return 'done';
    }
    await repo.addEvent(job.jobId, {
      at: finishedAt,
      event: 'SUCCEEDED',
      attempt,
      message: `Completed in ${durationMs} ms. Wrote ${outputs.map((o) => o.name).join(', ')} to S3.`,
      dispatchId: job.dispatchId,
    });
    emitMetric('JobsSucceeded', 1);
    emitMetric('JobDurationMs', durationMs, 'Milliseconds');
    jlog.info('job succeeded', { durationMs });
    return 'done';
  } catch (err) {
    return handleFailure(job, attempt, receiveCount, err, record, deps, jlog);
  }
}

async function handleFailure(
  job: Job,
  attempt: number,
  receiveCount: number,
  err: unknown,
  record: SQSRecord,
  deps: WorkerDeps,
  log: Logger,
): Promise<RecordOutcome> {
  const cfg = getConfig();
  const at = deps.now().toISOString();
  const message = errorMessage(err);
  const code = errorCode(err);
  const expected = { status: 'PROCESSING' as const, dispatchId: job.dispatchId };

  // Non-retryable: bad input or parameters. Retrying unchanged cannot help -> FAILED now, message deleted.
  if (err instanceof NonRetryableJobError) {
    await repo.transitionJob(job.jobId, expected, { status: 'FAILED', finishedAt: at, updatedAt: at, lastError: { code, message, retryable: false, at } }, ['leaseUntil']);
    await repo.addEvent(job.jobId, { at, event: 'FAILED', attempt, message: `${message} (not retryable; fix the input or parameters and use Retry)`, dispatchId: job.dispatchId, details: { code } });
    emitMetric('JobsFailed', 1);
    log.warn('job failed (non-retryable)', { code, error: message });
    return 'done';
  }

  // Retryable and out of attempts -> mark DEAD_LETTERED; SQS's redrive policy moves the message to the DLQ.
  if (isFinalAttempt(attempt, receiveCount, cfg.maxAttempts)) {
    await repo.transitionJob(job.jobId, expected, { status: 'DEAD_LETTERED', finishedAt: at, updatedAt: at, lastError: { code, message, retryable: true, at } }, ['leaseUntil']);
    await repo.addEvent(job.jobId, { at, event: 'ATTEMPT_FAILED', attempt, message, dispatchId: job.dispatchId, details: { code } });
    await repo.addEvent(job.jobId, {
      at,
      event: 'DEAD_LETTERED',
      attempt,
      message: `All ${cfg.maxAttempts} attempts failed. SQS will move the message to the dead-letter queue.`,
      dispatchId: job.dispatchId,
    });
    // Make the message visible now so SQS moves it to the DLQ promptly instead of after the full visibility timeout.
    await delayRedelivery(record.receiptHandle, 0).catch((e) => log.warn('could not reset visibility', { err: e }));
    emitMetric('JobsDeadLettered', 1);
    log.error('job dead-lettered', { code, error: message });
    return 'retry';
  }

  // Retryable with attempts left -> exponential backoff via the message's visibility timeout.
  const delay = backoffDelaySeconds(attempt, cfg.backoffSeconds);
  const nextAttemptAt = new Date(Date.parse(at) + delay * 1000).toISOString();
  await repo.transitionJob(job.jobId, expected, { status: 'RETRY_SCHEDULED', updatedAt: at, nextAttemptAt, lastError: { code, message, retryable: true, at } }, ['leaseUntil']);
  await repo.addEvent(job.jobId, { at, event: 'ATTEMPT_FAILED', attempt, message, dispatchId: job.dispatchId, details: { code } });
  await repo.addEvent(job.jobId, {
    at,
    event: 'RETRY_SCHEDULED',
    attempt,
    message: `Retrying in ${delay} s (attempt ${attempt + 1} of ${cfg.maxAttempts}).`,
    dispatchId: job.dispatchId,
    details: { delaySeconds: delay, nextAttemptAt },
  });
  await delayRedelivery(record.receiptHandle, delay).catch((e) => log.warn('could not set backoff; SQS will use the queue visibility timeout', { err: e }));
  emitMetric('JobRetriesScheduled', 1);
  log.warn('attempt failed; retry scheduled', { code, error: message, delaySeconds: delay });
  return 'retry';
}

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  const deps: WorkerDeps = { remainingMs: () => context.getRemainingTimeInMillis(), sleep: defaultSleep, now: () => new Date() };
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    // Leave unstarted messages for a later invocation rather than risk a mid-job timeout.
    if (deps.remainingMs() < 3_000) {
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      const outcome = await processRecord(record, deps);
      if (outcome === 'retry') failures.push({ itemIdentifier: record.messageId });
    } catch (err) {
      // Infrastructure error (e.g. DynamoDB throttled): let SQS redeliver this message.
      logger.error('unexpected worker error', { messageId: record.messageId, err });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
