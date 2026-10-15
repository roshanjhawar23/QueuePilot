/**
 * In-memory stand-ins used ONLY by unit tests, so the worker and API logic can be exercised
 * without AWS. They honour the same conditional semantics as the real DynamoDB repository
 * (status + dispatchId + lease conditions). The real repository's AWS calls are tested separately
 * in jobsRepo.test.ts, and the real end-to-end behaviour is tested against AWS in tests/e2e.
 */
import { vi } from 'vitest';
import type { BackupRecord, Job, JobEvent, JobStatus } from '@queuepilot/shared';
import type * as StorageModule from '../../src/lib/storage.js';
import type * as QueueModule from '../../src/lib/queue.js';

const actualStorage = await vi.importActual<typeof StorageModule>('../../src/lib/storage.js');
const actualQueue = await vi.importActual<typeof QueueModule>('../../src/lib/queue.js');

export const state = {
  jobs: new Map<string, Job>(),
  events: new Map<string, JobEvent[]>(),
  idem: new Map<string, { jobId: string; requestHash: string }>(),
  backups: new Map<string, BackupRecord>(),
  s3: new Map<string, { body: Uint8Array; contentType: string }>(),
  sent: [] as { jobId: string; dispatchId: string }[],
  visibility: [] as { receiptHandle: string; seconds: number }[],
  failEnqueue: false,
};

export function resetState() {
  state.jobs.clear();
  state.events.clear();
  state.idem.clear();
  state.backups.clear();
  state.s3.clear();
  state.sent.length = 0;
  state.visibility.length = 0;
  state.failEnqueue = false;
}

const clone = <T>(v: T): T => structuredClone(v);

export const fakeRepo = {
  async createJob(job: Job, event: JobEvent, idempotency?: { key: string; requestHash: string }) {
    if (idempotency && state.idem.has(idempotency.key)) return false;
    state.jobs.set(job.jobId, clone(job));
    state.events.set(job.jobId, [clone(event)]);
    if (idempotency) state.idem.set(idempotency.key, { jobId: job.jobId, requestHash: idempotency.requestHash });
    return true;
  },
  async getIdempotencyRecord(key: string) {
    return state.idem.get(key) ?? null;
  },
  async getJob(jobId: string) {
    const j = state.jobs.get(jobId);
    return j ? clone(j) : null;
  },
  async getJobs(ids: string[]) {
    const m = new Map<string, Job>();
    for (const id of ids) if (state.jobs.has(id)) m.set(id, clone(state.jobs.get(id)!));
    return m;
  },
  async getJobWithEvents(jobId: string) {
    const j = state.jobs.get(jobId);
    return { job: j ? clone(j) : null, events: clone(state.events.get(jobId) ?? []) };
  },
  async listJobs(opts: { status?: JobStatus; limit: number }) {
    const items = [...state.jobs.values()].filter((j) => !opts.status || j.status === opts.status).slice(0, opts.limit);
    return { items: clone(items), nextCursor: null };
  },
  async countByStatus() {
    const counts: Record<string, number> = {};
    for (const j of state.jobs.values()) counts[j.status] = (counts[j.status] ?? 0) + 1;
    return counts;
  },
  async addEvent(jobId: string, event: JobEvent) {
    const list = state.events.get(jobId) ?? [];
    list.push(clone(event));
    state.events.set(jobId, list);
  },
  async transitionJob(
    jobId: string,
    expected: { status: JobStatus; dispatchId: string; leaseExpiredBefore?: string },
    set: Partial<Job>,
    remove: (keyof Job)[] = [],
  ) {
    const j = state.jobs.get(jobId);
    if (!j || j.status !== expected.status || j.dispatchId !== expected.dispatchId) return null;
    if (expected.leaseExpiredBefore && j.leaseUntil && !(j.leaseUntil < expected.leaseExpiredBefore)) return null;
    const next = { ...j, ...clone(set) } as Job;
    for (const k of remove) delete next[k];
    state.jobs.set(jobId, next);
    return clone(next);
  },
  async deleteJobRecords(jobId: string) {
    const n = (state.jobs.has(jobId) ? 1 : 0) + (state.events.get(jobId)?.length ?? 0);
    state.jobs.delete(jobId);
    state.events.delete(jobId);
    return n;
  },
  async putRestoredJob(job: Job, events: JobEvent[], onlyIfMissing: boolean) {
    if (onlyIfMissing && state.jobs.has(job.jobId)) return false;
    state.jobs.set(job.jobId, clone(job));
    state.events.set(job.jobId, [...(state.events.get(job.jobId) ?? []), ...clone(events)]);
    return true;
  },
  async putBackup(b: BackupRecord) {
    state.backups.set(b.backupId, clone(b));
  },
  async getBackup(id: string) {
    return state.backups.has(id) ? clone(state.backups.get(id)!) : null;
  },
  async listBackups() {
    return clone([...state.backups.values()]);
  },
  async markBackupRestored(id: string, at: string) {
    const b = state.backups.get(id);
    if (b) b.lastRestoredAt = at;
  },
};

class NotFound extends Error {
  override name = 'NotFound';
}

export const fakeStorage = {
  isNotFound: (err: unknown) => (err as { name?: string })?.name === 'NotFound',
  async presignUpload(key: string, contentType: string) {
    return { url: 'https://example-bucket.s3.amazonaws.com/', fields: { key, 'Content-Type': contentType, Policy: 'x' } };
  },
  async headObject(key: string) {
    const o = state.s3.get(key);
    return o ? { sizeBytes: o.body.length, contentType: o.contentType } : null;
  },
  async getObjectBytes(key: string) {
    const o = state.s3.get(key);
    if (!o) throw new NotFound(key);
    return o.body;
  },
  async putObject(key: string, body: string, contentType: string) {
    state.s3.set(key, { body: new TextEncoder().encode(body), contentType });
  },
  async presignDownload(key: string) {
    return `https://signed.example/${key}`;
  },
  sha256Hex: actualStorage.sha256Hex,
};

export const fakeQueue = {
  parseJobMessage: actualQueue.parseJobMessage,
  async enqueueJob(jobId: string, dispatchId: string) {
    if (state.failEnqueue) throw new Error('SQS unavailable');
    state.sent.push({ jobId, dispatchId });
    return 'msg-1';
  },
  async delayRedelivery(receiptHandle: string, seconds: number) {
    state.visibility.push({ receiptHandle, seconds });
  },
  async getQueueDepth() {
    return { visible: 0, inFlight: 0, delayed: 0 };
  },
  async peekDlq() {
    return [];
  },
  async startRedrive() {
    return 'task-1';
  },
  async listRedriveTasks() {
    return [];
  },
};

export function setTestEnv() {
  Object.assign(process.env, {
    TABLE_NAME: 'test-table',
    DATA_BUCKET: 'test-bucket',
    QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
    QUEUE_ARN: 'arn:aws:sqs:us-east-1:123456789012:q',
    DLQ_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/dlq',
    DLQ_ARN: 'arn:aws:sqs:us-east-1:123456789012:dlq',
    MAX_ATTEMPTS: '3',
    BACKOFF_SECONDS: '5,20',
    WORKER_TIMEOUT_SECONDS: '15',
    AWS_REGION: 'us-east-1',
  });
}
