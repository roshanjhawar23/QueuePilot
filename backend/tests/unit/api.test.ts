import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Job } from '@queuepilot/shared';
import { fakeQueue, fakeRepo, fakeStorage, resetState, setTestEnv, state } from './fakes.js';

vi.mock('../../src/lib/jobsRepo.js', () => fakeRepo);
vi.mock('../../src/lib/storage.js', () => fakeStorage);
vi.mock('../../src/lib/queue.js', () => fakeQueue);
vi.mock('../../src/lib/metrics.js', () => ({ emitMetric: vi.fn() }));

const { handler, routes } = await import('../../src/handlers/api.js');
const { prepareRestoredJob } = await import('../../src/routes/backups.js');
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const UPLOAD = 'inputs/22222222-2222-4222-8222-222222222222/data.csv';

function req(routeKey: string, opts: { body?: unknown; headers?: Record<string, string>; path?: Record<string, string>; query?: Record<string, string> } = {}) {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/',
    rawQueryString: '',
    headers: opts.headers ?? {},
    pathParameters: opts.path,
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: { requestId: 'req-1' },
  } as unknown as APIGatewayProxyEventV2;
}

async function call(routeKey: string, opts?: Parameters<typeof req>[1]) {
  const res = await handler(req(routeKey, opts));
  return { status: res.statusCode!, body: JSON.parse(res.body as string) };
}

beforeEach(() => {
  setTestEnv();
  resetState();
  state.s3.set(UPLOAD, { body: new TextEncoder().encode('a,b\n1,2\n'), contentType: 'text/csv' });
});

describe('routing and errors', () => {
  it('exposes the documented routes', () => {
    expect(Object.keys(routes)).toHaveLength(14);
  });
  it('returns 404 for unknown routes and a JSON error body', async () => {
    const r = await call('GET /nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', requestId: 'req-1' });
  });
  it('rejects invalid JSON bodies', async () => {
    const e = req('POST /jobs');
    e.body = '{oops';
    const res = await handler(e);
    expect(res.statusCode).toBe(400);
  });
  it('hides internal error details from callers', async () => {
    const spy = vi.spyOn(fakeRepo, 'listJobs').mockRejectedValueOnce(new Error('secret table detail'));
    const r = await call('GET /jobs');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret');
    spy.mockRestore();
  });
  it('health check works', async () => {
    expect((await call('GET /health')).body.ok).toBe(true);
  });
});

describe('POST /uploads', () => {
  it('returns a presigned POST for an allowed file', async () => {
    const r = await call('POST /uploads', { body: { fileName: 'My Data.csv', sizeBytes: 1000 } });
    expect(r.status).toBe(201);
    expect(r.body.inputKey).toMatch(/^inputs\/[0-9a-f-]{36}\/My_Data\.csv$/);
    expect(r.body.fields['Content-Type']).toBe('text/csv');
    expect(r.body.maxBytes).toBe(5 * 1024 * 1024);
  });
  it('rejects files over 5 MB and unsupported extensions', async () => {
    expect((await call('POST /uploads', { body: { fileName: 'big.csv', sizeBytes: 5 * 1024 * 1024 + 1 } })).status).toBe(400);
    expect((await call('POST /uploads', { body: { fileName: 'virus.exe', sizeBytes: 10 } })).status).toBe(400);
    expect((await call('POST /uploads', { body: { fileName: '../../etc/passwd.csv', sizeBytes: 10 } })).status).toBe(400);
  });
});

describe('POST /jobs', () => {
  it('creates a QUEUED job, records SUBMITTED and sends one SQS message', async () => {
    const r = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD } });
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({ status: 'QUEUED', type: 'csv.summary', fileName: 'data.csv', failMode: 'none' });
    expect(r.body.job.params).toEqual({ delimiter: ',', topN: 5, maxMalformedPercent: 20 });
    expect(state.sent).toEqual([{ jobId: r.body.job.jobId, dispatchId: r.body.job.dispatchId }]);
    expect(state.events.get(r.body.job.jobId)![0]!.event).toBe('SUBMITTED');
  });

  it('is idempotent: the same key and body returns the original job without a second message', async () => {
    const headers = { 'idempotency-key': 'key-12345678' };
    const a = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD }, headers });
    const b = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD }, headers });
    expect(b.status).toBe(200);
    expect(b.body.idempotentReplay).toBe(true);
    expect(b.body.job.jobId).toBe(a.body.job.jobId);
    expect(state.sent).toHaveLength(1);
    expect(state.jobs.size).toBe(1);
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const headers = { 'idempotency-key': 'key-12345678' };
    await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD }, headers });
    const r = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD, failMode: 'permanent' }, headers });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('validates type/extension compatibility, parameters, and that the upload exists', async () => {
    expect((await call('POST /jobs', { body: { type: 'text.analytics', inputKey: UPLOAD } })).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const badParams = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD, params: { topN: 999 } } });
    expect(badParams.body.error.code).toBe('INVALID_PARAMS');
    const noRules = await call('POST /jobs', { body: { type: 'data.validate', inputKey: UPLOAD } });
    expect(noRules.body.error.code).toBe('INVALID_PARAMS');
    const missing = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: 'inputs/33333333-3333-4333-8333-333333333333/x.csv' } });
    expect(missing.body.error.code).toBe('UPLOAD_NOT_FOUND');
    expect((await call('POST /jobs', { body: { type: 'csv.summary', inputKey: 'outputs/evil.csv' } })).status).toBe(400);
    expect((await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD }, headers: { 'idempotency-key': 'bad key!' } })).status).toBe(400);
  });

  it('marks the job FAILED (retryable) and returns 503 if SQS is unavailable', async () => {
    state.failEnqueue = true;
    const r = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD } });
    expect(r.status).toBe(503);
    const job = [...state.jobs.values()][0]!;
    expect(job.status).toBe('FAILED');
    expect(job.lastError).toMatchObject({ code: 'DISPATCH_FAILED', retryable: true });
  });
});

describe('job queries', () => {
  it('returns job detail with timeline and presigned downloads', async () => {
    const created = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD } });
    const id = created.body.job.jobId as string;
    const j = state.jobs.get(id)!;
    j.status = 'SUCCEEDED';
    j.outputs = [{ name: 'result.json', key: `outputs/${id}/result.json`, contentType: 'application/json', sizeBytes: 2 }];
    state.s3.set(`outputs/${id}/result.json`, { body: new Uint8Array([123, 125]), contentType: 'application/json' });
    const r = await call('GET /jobs/{jobId}', { path: { jobId: id } });
    expect(r.status).toBe(200);
    expect(r.body.events).toHaveLength(1);
    expect(r.body.downloads[0]).toMatchObject({ name: 'result.json', available: true });
    expect(r.body.downloads[0].url).toContain(`outputs/${id}/result.json`);
  });
  it('validates ids and list query parameters', async () => {
    expect((await call('GET /jobs/{jobId}', { path: { jobId: 'nope' } })).status).toBe(400);
    expect((await call('GET /jobs/{jobId}', { path: { jobId: crypto.randomUUID() } })).status).toBe(404);
    expect((await call('GET /jobs', { query: { status: 'BOGUS' } })).status).toBe(400);
    expect((await call('GET /jobs', { query: { limit: '500' } })).status).toBe(400);
    expect((await call('GET /jobs', { query: { status: 'QUEUED', limit: '10' } })).status).toBe(200);
  });
});

describe('POST /jobs/{jobId}/retry', () => {
  async function failedJob(status: Job['status'] = 'DEAD_LETTERED', failMode: Job['failMode'] = 'permanent') {
    const r = await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD, failMode } });
    const j = state.jobs.get(r.body.job.jobId)!;
    j.status = status;
    j.cycleAttempts = 3;
    return j;
  }

  it('re-dispatches a dead-lettered job with a NEW dispatchId and corrected settings', async () => {
    const j = await failedJob();
    const oldDispatch = j.dispatchId;
    const r = await call('POST /jobs/{jobId}/retry', { path: { jobId: j.jobId }, body: { failMode: 'none', params: { maxMalformedPercent: 50 } } });
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({ status: 'QUEUED', failMode: 'none', cycleAttempts: 0, retryCount: 1 });
    expect(r.body.job.params.maxMalformedPercent).toBe(50);
    expect(r.body.job.params.topN).toBe(5); // merged with existing params
    expect(r.body.job.dispatchId).not.toBe(oldDispatch);
    expect(state.sent.at(-1)!.dispatchId).toBe(r.body.job.dispatchId);
    const ev = state.events.get(j.jobId)!.at(-1)!;
    expect(ev.event).toBe('RETRY_REQUESTED');
    expect(ev.message).toMatch(/stale/);
  });

  it('refuses to retry active or succeeded jobs and invalid corrected parameters', async () => {
    const j = await failedJob('QUEUED');
    expect((await call('POST /jobs/{jobId}/retry', { path: { jobId: j.jobId } })).body.error.code).toBe('RETRY_NOT_ALLOWED');
    j.status = 'SUCCEEDED';
    expect((await call('POST /jobs/{jobId}/retry', { path: { jobId: j.jobId } })).status).toBe(409);
    j.status = 'FAILED';
    expect((await call('POST /jobs/{jobId}/retry', { path: { jobId: j.jobId }, body: { params: { delimiter: 'x' } } })).body.error.code).toBe('INVALID_PARAMS');
  });

  it('allows retrying a stuck PROCESSING job whose lease has expired', async () => {
    const j = await failedJob('PROCESSING');
    j.leaseUntil = '2000-01-01T00:00:00.000Z';
    expect((await call('POST /jobs/{jobId}/retry', { path: { jobId: j.jobId } })).status).toBe(202);
  });

  it('refuses when the input file has expired from S3', async () => {
    const j = await failedJob('FAILED');
    state.s3.delete(UPLOAD);
    expect((await call('POST /jobs/{jobId}/retry', { path: { jobId: j.jobId } })).body.error.code).toBe('INPUT_EXPIRED');
  });
});

describe('backup and restore', () => {
  it('backs up selected jobs, restores a deleted job, and skips existing ones in missing-only mode', async () => {
    const a = (await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD } })).body.job;
    const b = (await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD } })).body.job;
    state.jobs.get(a.jobId)!.status = 'SUCCEEDED';
    state.jobs.get(b.jobId)!.status = 'SUCCEEDED';

    const backup = await call('POST /backups', { body: { jobIds: [a.jobId, b.jobId, crypto.randomUUID()], label: 'demo' } });
    expect(backup.status).toBe(201);
    expect(backup.body.backup).toMatchObject({ jobCount: 2, label: 'demo' });
    expect(backup.body.notFound).toHaveLength(1);
    expect(state.s3.has(backup.body.backup.s3Key)).toBe(true);

    expect((await call('DELETE /jobs/{jobId}', { path: { jobId: a.jobId } })).status).toBe(200);
    expect(state.jobs.has(a.jobId)).toBe(false);

    const restore = await call('POST /backups/{backupId}/restore', { path: { backupId: backup.body.backup.backupId }, body: { mode: 'missing-only' } });
    expect(restore.status).toBe(200);
    expect(restore.body.restored).toEqual([a.jobId]);
    expect(restore.body.skipped).toEqual([{ jobId: b.jobId, reason: expect.stringMatching(/already exists/) }]);
    expect(state.jobs.get(a.jobId)!.restoredFromBackupId).toBe(backup.body.backup.backupId);
    expect(state.events.get(a.jobId)!.at(-1)!.event).toBe('RESTORED');
    expect((await call('GET /backups')).body.items[0].lastRestoredAt).toBeDefined();
  });

  it('refuses to restore a tampered backup (SHA-256 mismatch)', async () => {
    const a = (await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD } })).body.job;
    state.jobs.get(a.jobId)!.status = 'FAILED';
    const backup = (await call('POST /backups', { body: { jobIds: [a.jobId] } })).body.backup;
    const obj = state.s3.get(backup.s3Key)!;
    state.s3.set(backup.s3Key, { ...obj, body: new TextEncoder().encode(new TextDecoder().decode(obj.body).replace('FAILED', 'SUCCEEDED')) });
    const r = await call('POST /backups/{backupId}/restore', { path: { backupId: backup.backupId }, body: {} });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INTEGRITY_CHECK_FAILED');
  });

  it('never deletes or overwrites active jobs', async () => {
    const a = (await call('POST /jobs', { body: { type: 'csv.summary', inputKey: UPLOAD } })).body.job;
    expect((await call('DELETE /jobs/{jobId}', { path: { jobId: a.jobId } })).body.error.code).toBe('JOB_ACTIVE');
    const backup = (await call('POST /backups', { body: { jobIds: [a.jobId] } })).body.backup;
    const r = await call('POST /backups/{backupId}/restore', { path: { backupId: backup.backupId }, body: { mode: 'overwrite' } });
    expect(r.body.restored).toEqual([]);
    expect(r.body.skipped[0].reason).toMatch(/active jobs are never overwritten/);
  });

  it('restores in-flight snapshots as FAILED (retryable) so they cannot get stuck', () => {
    const job = { status: 'PROCESSING', leaseUntil: 'x', jobId: 'j' } as unknown as Job;
    const r = prepareRestoredJob(job, 'b1', '2026-10-10T00:00:00.000Z');
    expect(r.status).toBe('FAILED');
    expect(r.lastError?.code).toBe('RESTORED_IN_FLIGHT');
    expect(r.leaseUntil).toBeUndefined();
  });
});
