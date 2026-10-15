import { MAX_UPLOAD_BYTES } from '@queuepilot/shared';
import type { DlqMessagePreview, DlqMessagesResponse, RedriveStatusResponse, SystemMetricsResponse } from '@queuepilot/shared';
import { getConfig } from '../lib/config.js';
import { HttpError } from '../lib/errors.js';
import { json } from '../lib/http.js';
import * as repo from '../lib/jobsRepo.js';
import { getQueueDepth, listRedriveTasks, parseJobMessage, peekDlq, startRedrive } from '../lib/queue.js';
import type { RouteHandler } from './context.js';

/** GET /health - unauthenticated liveness check. */
export const health: RouteHandler = async () => json(200, { ok: true, service: 'queuepilot-api', time: new Date().toISOString() });

/** GET /system/metrics - live numbers read from SQS and DynamoDB at request time. */
export const systemMetrics: RouteHandler = async () => {
  const cfg = getConfig();
  const [queue, dlq, statusCounts] = await Promise.all([getQueueDepth(cfg.queueUrl), getQueueDepth(cfg.dlqUrl), repo.countByStatus()]);
  const body: SystemMetricsResponse = {
    queue,
    dlq,
    statusCounts,
    config: { maxAttempts: cfg.maxAttempts, maxUploadBytes: MAX_UPLOAD_BYTES, workerTimeoutSeconds: cfg.workerTimeoutSeconds, region: cfg.region },
    sampledAt: new Date().toISOString(),
  };
  return json(200, body);
};

/** GET /dlq/messages - a preview of messages currently in the dead-letter queue. */
export const dlqMessages: RouteHandler = async () => {
  const raw = await peekDlq();
  const parsed = raw.map((m) => ({ m, msg: parseJobMessage(m.body) }));
  const jobs = await repo.getJobs(parsed.flatMap((p) => (p.msg ? [p.msg.jobId] : [])));
  const messages: DlqMessagePreview[] = parsed.map(({ m, msg }) => {
    const job = msg ? jobs.get(msg.jobId) : undefined;
    return {
      messageId: m.messageId,
      jobId: msg?.jobId ?? null,
      dispatchId: msg?.dispatchId ?? null,
      sentAt: m.sentAt,
      receiveCount: m.receiveCount,
      stale: Boolean(msg && job && job.dispatchId !== msg.dispatchId),
      jobStatus: msg ? (job?.status ?? 'MISSING') : null,
    };
  });
  const body: DlqMessagesResponse = {
    messages,
    note: 'Preview of up to 10 messages. SQS short polling samples a subset of servers, so the list may be incomplete; the DLQ depth metric is authoritative.',
  };
  return json(200, body);
};

/** POST /dlq/redrive - starts a native SQS message move task (DLQ -> main queue). */
export const startDlqRedrive: RouteHandler = async ({ log }) => {
  const cfg = getConfig();
  const depth = await getQueueDepth(cfg.dlqUrl);
  if (depth.visible + depth.inFlight === 0) throw new HttpError(409, 'DLQ_EMPTY', 'The dead-letter queue is empty; there is nothing to redrive.');
  const running = (await listRedriveTasks()).find((t) => t.status === 'RUNNING');
  if (running) throw new HttpError(409, 'REDRIVE_IN_PROGRESS', 'A redrive task is already running.');
  try {
    const taskHandle = await startRedrive();
    log.info('dlq redrive started', { taskHandle, messages: depth.visible });
    return json(202, { taskHandle, approximateMessages: depth.visible });
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (/already|active|running/i.test(e.message ?? '')) throw new HttpError(409, 'REDRIVE_IN_PROGRESS', 'A redrive task is already running.');
    throw err;
  }
};

/** GET /dlq/redrive - status of recent redrive tasks. */
export const dlqRedriveStatus: RouteHandler = async () => {
  const body: RedriveStatusResponse = { tasks: await listRedriveTasks() };
  return json(200, body);
};
