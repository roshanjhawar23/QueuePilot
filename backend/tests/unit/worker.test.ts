import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSRecord } from 'aws-lambda';
import type { FailMode, Job, JobType } from '@queuepilot/shared';
import { parseJobParams } from '@queuepilot/shared';
import { fakeQueue, fakeRepo, fakeStorage, resetState, setTestEnv, state } from './fakes.js';

vi.mock('../../src/lib/jobsRepo.js', () => fakeRepo);
vi.mock('../../src/lib/storage.js', () => fakeStorage);
vi.mock('../../src/lib/queue.js', () => fakeQueue);
vi.mock('../../src/lib/metrics.js', () => ({ emitMetric: vi.fn() }));

const { processRecord, handler } = await import('../../src/handlers/worker.js');
const { createLogger } = await import('../../src/lib/logger.js');

const sampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sample-data');
const silent = createLogger();
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

let clock = new Date('2026-10-10T12:00:00Z');
const deps = {
  remainingMs: () => 15_000,
  sleep: vi.fn(async (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  }),
  now: () => clock,
};

function seedJob(opts: { type?: JobType; failMode?: FailMode; file?: string; params?: unknown } = {}): Job {
  const type = opts.type ?? 'csv.summary';
  const file = opts.file ?? 'sales.csv';
  const inputKey = `inputs/11111111-1111-4111-8111-111111111111/${file}`;
  state.s3.set(inputKey, { body: new Uint8Array(readFileSync(path.join(sampleDir, file))), contentType: 'text/csv' });
  const job: Job = {
    jobId: crypto.randomUUID(),
    type,
    status: 'QUEUED',
    fileName: file,
    inputKey,
    inputSizeBytes: 100,
    params: parseJobParams(type, opts.params ?? {}),
    failMode: opts.failMode ?? 'none',
    dispatchId: crypto.randomUUID(),
    cycleAttempts: 0,
    totalAttempts: 0,
    maxAttempts: 3,
    retryCount: 0,
    outputs: [],
    createdAt: clock.toISOString(),
    updatedAt: clock.toISOString(),
  };
  state.jobs.set(job.jobId, job);
  state.events.set(job.jobId, []);
  return job;
}

let receiveCounter = 0;
function record(job: Pick<Job, 'jobId' | 'dispatchId'>, receiveCount = 1): SQSRecord {
  receiveCounter++;
  return {
    messageId: `m-${receiveCounter}`,
    receiptHandle: `rh-${receiveCounter}`,
    body: JSON.stringify({ jobId: job.jobId, dispatchId: job.dispatchId, enqueuedAt: clock.toISOString() }),
    attributes: { ApproximateReceiveCount: String(receiveCount) } as SQSRecord['attributes'],
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:q',
    awsRegion: 'us-east-1',
  };
}

const job = (id: string) => state.jobs.get(id)!;
const eventNames = (id: string) => state.events.get(id)!.map((e) => e.event);
const advance = (s: number) => (clock = new Date(clock.getTime() + s * 1000));

beforeEach(() => {
  setTestEnv();
  resetState();
  clock = new Date('2026-10-10T12:00:00Z');
});

describe('worker: happy path', () => {
  it('processes a CSV job end to end and records outputs in S3', async () => {
    const j = seedJob();
    expect(await processRecord(record(j), deps, silent)).toBe('done');
    const done = job(j.jobId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.cycleAttempts).toBe(1);
    expect(done.outputs.map((o) => o.key)).toEqual([`outputs/${j.jobId}/result.json`, `outputs/${j.jobId}/cleaned.csv`]);
    expect(state.s3.has(`outputs/${j.jobId}/result.json`)).toBe(true);
    expect(done.resultSummary).toMatchObject({ validRows: 60 });
    expect(done.leaseUntil).toBeUndefined();
    expect(eventNames(j.jobId)).toEqual(['STARTED', 'SUCCEEDED']);
  });
});

describe('worker: retries and dead-lettering', () => {
  it('transient fault: fails twice with 5 s then 20 s backoff, then succeeds on attempt 3', async () => {
    const j = seedJob({ failMode: 'transient' });
    expect(await processRecord(record(j, 1), deps, silent)).toBe('retry');
    expect(job(j.jobId).status).toBe('RETRY_SCHEDULED');
    expect(state.visibility.at(-1)!.seconds).toBe(5);

    advance(5);
    expect(await processRecord(record(j, 2), deps, silent)).toBe('retry');
    expect(state.visibility.at(-1)!.seconds).toBe(20);

    advance(20);
    expect(await processRecord(record(j, 3), deps, silent)).toBe('done');
    expect(job(j.jobId).status).toBe('SUCCEEDED');
    expect(job(j.jobId).totalAttempts).toBe(3);
    expect(job(j.jobId).lastError).toBeUndefined();
    expect(eventNames(j.jobId)).toEqual([
      'STARTED', 'ATTEMPT_FAILED', 'RETRY_SCHEDULED',
      'STARTED', 'ATTEMPT_FAILED', 'RETRY_SCHEDULED',
      'STARTED', 'SUCCEEDED',
    ]);
  });

  it('permanent fault: after 3 attempts the job is DEAD_LETTERED and the message is released to the DLQ', async () => {
    const j = seedJob({ failMode: 'permanent' });
    await processRecord(record(j, 1), deps, silent);
    advance(5);
    await processRecord(record(j, 2), deps, silent);
    advance(20);
    expect(await processRecord(record(j, 3), deps, silent)).toBe('retry'); // SQS then moves it (maxReceiveCount = 3)
    const dl = job(j.jobId);
    expect(dl.status).toBe('DEAD_LETTERED');
    expect(dl.lastError).toMatchObject({ code: 'INJECTED_FAULT', retryable: true });
    expect(state.visibility.at(-1)!.seconds).toBe(0);
    expect(eventNames(j.jobId).slice(-2)).toEqual(['ATTEMPT_FAILED', 'DEAD_LETTERED']);
  });

  it('non-retryable data error: FAILED immediately, message acknowledged, no backoff', async () => {
    const j = seedJob({ file: 'malformed.csv' });
    expect(await processRecord(record(j), deps, silent)).toBe('done');
    expect(job(j.jobId).status).toBe('FAILED');
    expect(job(j.jobId).lastError).toMatchObject({ code: 'TOO_MANY_MALFORMED_ROWS', retryable: false });
    expect(state.visibility).toHaveLength(0);
  });

  it('missing input object is non-retryable', async () => {
    const j = seedJob();
    state.s3.delete(j.inputKey);
    await processRecord(record(j), deps, silent);
    expect(job(j.jobId).lastError?.code).toBe('INPUT_MISSING');
  });

  it('uses the SQS receive count as a safety net for the final attempt', async () => {
    const j = seedJob({ failMode: 'permanent' });
    // e.g. earlier deliveries were lost before the job record was updated
    await processRecord(record(j, 3), deps, silent);
    expect(job(j.jobId).status).toBe('DEAD_LETTERED');
  });
});

describe('worker: timeouts, duplicates and stale messages', () => {
  it('slow fault: attempt 1 runs past the time budget; the redelivery takes over after the lease and succeeds', async () => {
    const j = seedJob({ failMode: 'slow' });
    // Simulate Lambda killing the invocation: the sleep never returns.
    const killed = { ...deps, sleep: () => new Promise<void>(() => {}) };
    void processRecord(record(j, 1), killed, silent);
    await vi.waitFor(() => expect(job(j.jobId).status).toBe('PROCESSING'));
    expect(job(j.jobId).leaseUntil).toBe('2026-10-10T12:00:20.000Z'); // timeout 15 s + 5 s

    advance(90); // queue visibility timeout elapses, SQS redelivers
    expect(await processRecord(record(j, 2), deps, silent)).toBe('done');
    expect(job(j.jobId).status).toBe('SUCCEEDED');
    expect(job(j.jobId).cycleAttempts).toBe(2);
    expect(eventNames(j.jobId)).toEqual(['STARTED', 'ATTEMPT_FAILED', 'STARTED', 'SUCCEEDED']);
    expect(state.events.get(j.jobId)![1]!.message).toMatch(/timed out or crashed/);
  });

  it('defers a duplicate delivery while another invocation holds the lease', async () => {
    const j = seedJob();
    state.jobs.set(j.jobId, { ...j, status: 'PROCESSING', cycleAttempts: 1, leaseUntil: '2026-10-10T12:00:10.000Z' });
    expect(await processRecord(record(j, 2), deps, silent)).toBe('retry');
    expect(state.visibility.at(-1)!.seconds).toBe(11);
    expect(job(j.jobId).cycleAttempts).toBe(1); // untouched
  });

  it('discards a duplicate of a finished job', async () => {
    const j = seedJob();
    await processRecord(record(j), deps, silent);
    expect(await processRecord(record(j, 2), deps, silent)).toBe('done');
    expect(eventNames(j.jobId).at(-1)).toBe('DUPLICATE_DISCARDED');
    expect(job(j.jobId).totalAttempts).toBe(1);
  });

  it('discards a stale message whose dispatchId was replaced by a manual retry', async () => {
    const j = seedJob();
    const stale = { jobId: j.jobId, dispatchId: crypto.randomUUID() };
    expect(await processRecord(record(stale), deps, silent)).toBe('done');
    expect(job(j.jobId).status).toBe('QUEUED');
    expect(eventNames(j.jobId)).toEqual(['STALE_MESSAGE_DISCARDED']);
  });

  it('discards messages for deleted jobs and sends unreadable messages towards the DLQ', async () => {
    expect(await processRecord(record({ jobId: crypto.randomUUID(), dispatchId: 'x' }), deps, silent)).toBe('done');
    const bad = record({ jobId: 'a', dispatchId: 'b' });
    bad.body = 'not json';
    expect(await processRecord(bad, deps, silent)).toBe('retry');
  });

  it('a redriven DLQ message starts a fresh attempt cycle', async () => {
    const j = seedJob({ failMode: 'transient' });
    state.jobs.set(j.jobId, { ...j, status: 'DEAD_LETTERED', cycleAttempts: 3, totalAttempts: 3 });
    // redriven message: same dispatchId; transient fails on cycle attempt 1 again
    expect(await processRecord(record(j, 1), deps, silent)).toBe('retry');
    expect(job(j.jobId)).toMatchObject({ status: 'RETRY_SCHEDULED', cycleAttempts: 1, totalAttempts: 4 });
    expect(eventNames(j.jobId).slice(0, 2)).toEqual(['REDRIVEN', 'STARTED']);
  });
});

describe('worker handler (partial batch response)', () => {
  it('reports only the failed messages in batchItemFailures', async () => {
    const ok = seedJob();
    const bad = seedJob({ failMode: 'permanent' });
    const ctx = { getRemainingTimeInMillis: () => 15_000 } as Parameters<typeof handler>[1];
    const r1 = record(ok);
    const r2 = record(bad);
    const res = await handler({ Records: [r1, r2] }, ctx);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: r2.messageId }]);
  });

  it('leaves messages unstarted when the invocation is almost out of time', async () => {
    const a = seedJob();
    const ctx = { getRemainingTimeInMillis: () => 2_000 } as Parameters<typeof handler>[1];
    const r = record(a);
    const res = await handler({ Records: [r] }, ctx);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: r.messageId }]);
    expect(job(a.jobId).status).toBe('QUEUED');
  });
});
