/**
 * END-TO-END TESTS AGAINST THE REAL, DEPLOYED AWS STACK.
 *
 * Nothing here is mocked: files go to S3, messages go through SQS, the worker Lambda runs,
 * and results are read back from S3. These tests only run when both values are set:
 *   QP_API_URL  (or backend/e2e.config.json { "apiUrl": ... }, written by scripts/deploy-backend.ps1)
 *   QP_TOKEN    (the demo token; never written to disk)
 * Run with:  scripts/run-e2e.ps1   (about 4-6 minutes; cost: a fraction of a cent)
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CreateUploadResponse, Job, JobDetailResponse, JobStatus, SystemMetricsResponse } from '@queuepilot/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../e2e.config.json');
const fileConfig = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf8')) as { apiUrl?: string }) : {};
const API = (process.env.QP_API_URL ?? fileConfig.apiUrl ?? '').replace(/\/+$/, '');
const TOKEN = process.env.QP_TOKEN ?? '';
const enabled = Boolean(API && TOKEN);
const sample = (name: string) => readFileSync(path.resolve(here, '../../../sample-data', name));

if (!enabled) {
  console.warn('[e2e] Skipped: set QP_TOKEN and QP_API_URL (or run scripts/run-e2e.ps1) to test the deployed stack.');
}

async function api<T>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function upload(fileName: string, content: Buffer): Promise<string> {
  const up = await api<CreateUploadResponse>('POST', '/uploads', { fileName, sizeBytes: content.length });
  expect(up.status).toBe(201);
  const form = new FormData();
  for (const [k, v] of Object.entries(up.body.fields)) form.append(k, v);
  form.append('file', new Blob([content]));
  const s3 = await fetch(up.body.url, { method: 'POST', body: form });
  expect(s3.status).toBe(204);
  return up.body.inputKey;
}

async function submit(type: Job['type'], fileName: string, opts: { params?: unknown; failMode?: string } = {}): Promise<Job> {
  const inputKey = await upload(fileName, sample(fileName));
  const res = await api<{ job: Job }>('POST', '/jobs', { type, inputKey, params: opts.params, failMode: opts.failMode ?? 'none' }, { 'idempotency-key': randomUUID() });
  expect(res.status).toBe(202);
  return res.body.job;
}

async function waitFor(jobId: string, statuses: JobStatus[], timeoutMs: number): Promise<JobDetailResponse> {
  const end = Date.now() + timeoutMs;
  let last: JobDetailResponse | null = null;
  while (Date.now() < end) {
    last = (await api<JobDetailResponse>('GET', `/jobs/${jobId}`)).body;
    if (statuses.includes(last.job.status)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Job ${jobId} did not reach ${statuses.join('/')} in time; last status ${last?.job.status}`);
}

async function waitForDlqDepth(min: number, timeoutMs: number): Promise<number> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const m = (await api<SystemMetricsResponse>('GET', '/system/metrics')).body;
    const depth = m.dlq.visible + m.dlq.inFlight;
    if (depth >= min) return depth;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`DLQ depth did not reach ${min}`);
}

describe.skipIf(!enabled)('live stack: security and limits', () => {
  it('health is public, everything else needs the token', async () => {
    expect((await fetch(`${API}/health`)).status).toBe(200);
    expect([401, 403]).toContain((await fetch(`${API}/jobs`)).status);
    expect([401, 403]).toContain((await fetch(`${API}/jobs`, { headers: { authorization: 'Bearer wrong-token-000000' } })).status);
  });

  it('S3 itself rejects an upload larger than 5 MB', async () => {
    const up = await api<CreateUploadResponse>('POST', '/uploads', { fileName: 'big.csv', sizeBytes: 1000 });
    const form = new FormData();
    for (const [k, v] of Object.entries(up.body.fields)) form.append(k, v);
    form.append('file', new Blob([Buffer.alloc(5 * 1024 * 1024 + 100, 97)]));
    const s3 = await fetch(up.body.url, { method: 'POST', body: form });
    expect(s3.status).toBe(400);
    expect(await s3.text()).toContain('EntityTooLarge');
  });

  it('idempotent submission returns the same job for the same key', async () => {
    const inputKey = await upload('sales.csv', sample('sales.csv'));
    const key = randomUUID();
    const a = await api<{ job: Job }>('POST', '/jobs', { type: 'csv.summary', inputKey }, { 'idempotency-key': key });
    const b = await api<{ job: Job; idempotentReplay: boolean }>('POST', '/jobs', { type: 'csv.summary', inputKey }, { 'idempotency-key': key });
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.body.idempotentReplay).toBe(true);
    expect(b.body.job.jobId).toBe(a.body.job.jobId);
  });
});

describe.skipIf(!enabled).concurrent('live stack: processing, retries and recovery', () => {
  it('csv.summary succeeds and the result can be downloaded from S3', async () => {
    const job = await submit('csv.summary', 'sales.csv');
    const done = await waitFor(job.jobId, ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'], 90_000);
    expect(done.job.status).toBe('SUCCEEDED');
    const result = done.downloads.find((d) => d.name === 'result.json')!;
    expect(result.available).toBe(true);
    const json = (await (await fetch(result.url)).json()) as { validRowCount: number; malformedRowCount: number };
    expect(json.validRowCount).toBe(60);
    expect(json.malformedRowCount).toBe(3);
  });

  it('text.analytics and data.validate succeed', async () => {
    const t = await submit('text.analytics', 'article.txt');
    const rules = JSON.parse(sample('customers.rules.json').toString());
    const v = await submit('data.validate', 'customers.csv', { params: rules });
    expect((await waitFor(t.jobId, ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'], 90_000)).job.status).toBe('SUCCEEDED');
    const vd = await waitFor(v.jobId, ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'], 90_000);
    expect(vd.job.resultSummary).toMatchObject({ passed: false, violations: 8 });
  });

  it('transient fault: two failed attempts with backoff, then success', async () => {
    const job = await submit('csv.summary', 'sales.csv', { failMode: 'transient' });
    const done = await waitFor(job.jobId, ['SUCCEEDED', 'DEAD_LETTERED'], 150_000);
    expect(done.job.status).toBe('SUCCEEDED');
    expect(done.job.totalAttempts).toBe(3);
    expect(done.events.filter((e) => e.event === 'RETRY_SCHEDULED')).toHaveLength(2);
  });

  it('non-retryable data error fails fast and succeeds after a corrected-parameter retry', async () => {
    const job = await submit('csv.summary', 'malformed.csv');
    const failed = await waitFor(job.jobId, ['FAILED', 'SUCCEEDED', 'DEAD_LETTERED'], 90_000);
    expect(failed.job.status).toBe('FAILED');
    expect(failed.job.lastError).toMatchObject({ code: 'TOO_MANY_MALFORMED_ROWS', retryable: false });
    expect(failed.job.totalAttempts).toBe(1);
    const retry = await api('POST', `/jobs/${job.jobId}/retry`, { params: { maxMalformedPercent: 50 } });
    expect(retry.status).toBe(202);
    expect((await waitFor(job.jobId, ['SUCCEEDED', 'FAILED'], 90_000)).job.status).toBe('SUCCEEDED');
  });

  it('permanent fault reaches the real DLQ, then is recovered by retry and by redrive', async () => {
    const a = await submit('text.analytics', 'article.txt', { failMode: 'permanent' });
    const b = await submit('text.analytics', 'article.txt', { failMode: 'permanent' });
    expect((await waitFor(a.jobId, ['DEAD_LETTERED', 'SUCCEEDED'], 180_000)).job.status).toBe('DEAD_LETTERED');
    expect((await waitFor(b.jobId, ['DEAD_LETTERED', 'SUCCEEDED'], 180_000)).job.status).toBe('DEAD_LETTERED');
    await waitForDlqDepth(2, 120_000);

    // Per-job retry with the fault turned off: succeeds; its DLQ copy becomes stale.
    expect((await api('POST', `/jobs/${a.jobId}/retry`, { failMode: 'none' })).status).toBe(202);
    expect((await waitFor(a.jobId, ['SUCCEEDED'], 90_000)).job.status).toBe('SUCCEEDED');

    // Bulk redrive with the native SQS API: b runs a fresh cycle (and fails again: still permanent),
    // a's stale copy is discarded without re-processing.
    const redrive = await api<{ taskHandle: string }>('POST', '/dlq/redrive');
    expect([202, 409]).toContain(redrive.status);
    const end = Date.now() + 240_000;
    let bEvents: string[] = [];
    let aEvents: string[] = [];
    while (Date.now() < end) {
      bEvents = (await api<JobDetailResponse>('GET', `/jobs/${b.jobId}`)).body.events.map((e) => e.event);
      aEvents = (await api<JobDetailResponse>('GET', `/jobs/${a.jobId}`)).body.events.map((e) => e.event);
      if (bEvents.includes('REDRIVEN') && aEvents.includes('STALE_MESSAGE_DISCARDED')) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(bEvents).toContain('REDRIVEN');
    expect(aEvents).toContain('STALE_MESSAGE_DISCARDED');
    const aFinal = (await api<JobDetailResponse>('GET', `/jobs/${a.jobId}`)).body.job;
    expect(aFinal.status).toBe('SUCCEEDED');
  });

  it('slow task: a real Lambda timeout, then success on redelivery', async () => {
    const job = await submit('csv.summary', 'sales.csv', { failMode: 'slow' });
    const done = await waitFor(job.jobId, ['SUCCEEDED', 'DEAD_LETTERED'], 240_000);
    expect(done.job.status).toBe('SUCCEEDED');
    expect(done.events.some((e) => e.event === 'ATTEMPT_FAILED' && /timed out or crashed/.test(e.message))).toBe(true);
  });

  it('backup, delete and restore a job record', async () => {
    const job = await submit('text.analytics', 'release-notes.md');
    await waitFor(job.jobId, ['SUCCEEDED'], 90_000);
    const backup = await api<{ backup: { backupId: string; jobCount: number } }>('POST', '/backups', { jobIds: [job.jobId], label: 'e2e' });
    expect(backup.status).toBe(201);
    expect((await api('DELETE', `/jobs/${job.jobId}`)).status).toBe(200);
    expect((await api('GET', `/jobs/${job.jobId}`)).status).toBe(404);
    const restore = await api<{ restored: string[] }>('POST', `/backups/${backup.body.backup.backupId}/restore`, { mode: 'missing-only' });
    expect(restore.body.restored).toEqual([job.jobId]);
    const back = await api<JobDetailResponse>('GET', `/jobs/${job.jobId}`);
    expect(back.body.job.status).toBe('SUCCEEDED');
    expect(back.body.events.at(-1)?.event).toBe('RESTORED');
  });
});
