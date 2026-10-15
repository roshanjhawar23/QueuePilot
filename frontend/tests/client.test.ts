import { describe, expect, it, vi } from 'vitest';
import { ApiError, QueuePilotClient, loadSession, saveSession } from '../src/api/client';

const session = { apiUrl: 'https://api.example.com', token: 'demo-token-1234567890' };

function fakeFetch(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } }));
}

describe('QueuePilotClient', () => {
  it('sends the bearer token and the idempotency key', async () => {
    const f = fakeFetch(202, { job: { jobId: 'j' }, idempotentReplay: false });
    const c = new QueuePilotClient(session, f);
    await c.createJob({ type: 'csv.summary', inputKey: 'inputs/x/a.csv' }, 'idem-key-123');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/jobs');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer demo-token-1234567890');
    expect(headers['idempotency-key']).toBe('idem-key-123');
    expect(JSON.parse(init.body as string)).toMatchObject({ type: 'csv.summary' });
  });

  it('builds list queries with status, limit and cursor', async () => {
    const f = fakeFetch(200, { items: [], nextCursor: null });
    await new QueuePilotClient(session, f).listJobs({ status: 'FAILED', limit: 15, cursor: 'abc' });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://api.example.com/jobs?status=FAILED&limit=15&cursor=abc');
  });

  it('turns API error bodies into ApiError with the server message', async () => {
    const c = new QueuePilotClient(session, fakeFetch(409, { error: { code: 'RETRY_NOT_ALLOWED', message: 'The job is already queued.' } }));
    await expect(c.retryJob('j')).rejects.toMatchObject({ status: 409, code: 'RETRY_NOT_ALLOWED', message: 'The job is already queued.' });
  });

  it('explains rejected tokens, throttling and network failures', async () => {
    await expect(new QueuePilotClient(session, fakeFetch(403, { message: 'Forbidden' })).metrics()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(new QueuePilotClient(session, fakeFetch(429, {})).metrics()).rejects.toMatchObject({ code: 'THROTTLED' });
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(new QueuePilotClient(session, down).metrics()).rejects.toBeInstanceOf(ApiError);
  });

  it('uploads to S3 as multipart form data with the file as the last field', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    const c = new QueuePilotClient(session, f);
    const file = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
    await c.uploadToS3({ uploadId: 'u', inputKey: 'k', url: 'https://bucket.s3.amazonaws.com/', fields: { key: 'k', Policy: 'p' }, maxBytes: 1, expiresInSeconds: 300 }, file);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://bucket.s3.amazonaws.com/');
    const keys = [...(init.body as FormData).keys()];
    expect(keys).toEqual(['key', 'Policy', 'file']);
    // The token must never be sent to S3.
    expect(init.headers).toBeUndefined();
  });

  it('reports S3 size-limit rejections clearly', async () => {
    const f = fakeFetch(400, '<Error><Code>EntityTooLarge</Code></Error>', 'application/xml');
    const c = new QueuePilotClient(session, f);
    await expect(c.uploadToS3({ uploadId: 'u', inputKey: 'k', url: 'https://b/', fields: {}, maxBytes: 1, expiresInSeconds: 1 }, new Blob(['x']))).rejects.toThrow(/larger than 5 MB/);
  });
});

describe('session storage', () => {
  it('round-trips and clears the session', () => {
    saveSession(session);
    expect(loadSession()).toEqual(session);
    saveSession(null);
    expect(loadSession()).toBeNull();
  });
});
