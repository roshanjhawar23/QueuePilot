/**
 * Verifies the exact DynamoDB requests the repository sends (conditions, indexes, TTL),
 * using aws-sdk-client-mock. No AWS account is contacted.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { Job } from '@queuepilot/shared';
import { setTestEnv } from './fakes.js';
import * as repo from '../../src/lib/jobsRepo.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const job: Job = {
  jobId: '44444444-4444-4444-8444-444444444444',
  type: 'csv.summary',
  status: 'QUEUED',
  fileName: 'a.csv',
  inputKey: 'inputs/x/a.csv',
  inputSizeBytes: 1,
  params: { delimiter: ',', topN: 5, maxMalformedPercent: 20 },
  failMode: 'none',
  dispatchId: 'd1',
  cycleAttempts: 0,
  totalAttempts: 0,
  maxAttempts: 3,
  retryCount: 0,
  outputs: [],
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
};

beforeEach(() => {
  setTestEnv();
  ddbMock.reset();
});

describe('jobsRepo item mapping', () => {
  it('adds keys, both GSIs and a TTL to job items', () => {
    const item = repo.jobToItem(job);
    expect(item).toMatchObject({
      PK: `JOB#${job.jobId}`,
      SK: 'META',
      GSI1PK: 'JOBS',
      GSI1SK: `${job.createdAt}#${job.jobId}`,
      GSI2PK: 'STATUS#QUEUED',
    });
    expect(item.expiresAt).toBeGreaterThan(Date.now() / 1000 + 6 * 86400);
  });
});

describe('createJob', () => {
  it('writes job, event and idempotency record in one transaction with conditions', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const ok = await repo.createJob(job, { at: job.createdAt, event: 'SUBMITTED', message: 'x' }, { key: 'k-12345678', requestHash: 'h' });
    expect(ok).toBe(true);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(3);
    expect(items[0]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(items[2]!.Put!.Item!.PK).toBe('IDEM#k-12345678');
    expect(items[2]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('returns false when the idempotency key already exists', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      }),
    );
    expect(await repo.createJob(job, { at: job.createdAt, event: 'SUBMITTED', message: 'x' }, { key: 'k-12345678', requestHash: 'h' })).toBe(false);
  });
});

describe('transitionJob (optimistic concurrency)', () => {
  it('sends a conditional update on status + dispatchId and moves the item in GSI2', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...repo.jobToItem({ ...job, status: 'PROCESSING' }) } });
    const updated = await repo.transitionJob(job.jobId, { status: 'QUEUED', dispatchId: 'd1' }, { status: 'PROCESSING', leaseUntil: 'L' }, ['nextAttemptAt']);
    expect(updated?.status).toBe('PROCESSING');
    expect((updated as unknown as Record<string, unknown>).PK).toBeUndefined(); // keys stripped
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('#status = :expStatus AND dispatchId = :expDispatch');
    expect(input.UpdateExpression).toMatch(/^SET .* REMOVE #r0$/);
    expect(Object.values(input.ExpressionAttributeValues!)).toContain('STATUS#PROCESSING');
  });

  it('adds a lease condition when taking over an abandoned job', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: repo.jobToItem(job) });
    await repo.transitionJob(job.jobId, { status: 'PROCESSING', dispatchId: 'd1', leaseExpiredBefore: 'NOW' }, { cycleAttempts: 2 });
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toContain('leaseUntil < :leaseNow');
    expect(input.ExpressionAttributeValues![':leaseNow']).toBe('NOW');
  });

  it('returns null (not an error) when the condition fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'no', $metadata: {} }));
    expect(await repo.transitionJob(job.jobId, { status: 'QUEUED', dispatchId: 'd1' }, { status: 'PROCESSING' })).toBeNull();
  });
});

describe('queries', () => {
  it('lists newest-first from GSI1, or from GSI2 when filtering by status, with an opaque cursor', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [repo.jobToItem(job)], LastEvaluatedKey: { PK: 'a', SK: 'b', GSI1PK: 'JOBS', GSI1SK: 'c' } });
    const page = await repo.listJobs({ limit: 10 });
    expect(page.items[0]!.jobId).toBe(job.jobId);
    expect(page.nextCursor).toBeTruthy();
    const first = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(first).toMatchObject({ IndexName: 'GSI1', ScanIndexForward: false, Limit: 10 });

    await repo.listJobs({ limit: 5, status: 'DEAD_LETTERED', cursor: page.nextCursor! });
    const second = ddbMock.commandCalls(QueryCommand)[1]!.args[0].input;
    expect(second.IndexName).toBe('GSI2');
    expect(second.ExpressionAttributeValues).toEqual({ ':pk': 'STATUS#DEAD_LETTERED' });
    expect(second.ExclusiveStartKey).toEqual({ PK: 'a', SK: 'b', GSI1PK: 'JOBS', GSI1SK: 'c' });
  });

  it('rejects forged cursors', () => {
    expect(() => repo.decodeCursor('not-base64-json')).toThrow(/cursor/);
    expect(() => repo.decodeCursor(Buffer.from(JSON.stringify({ PK: { S: 'x' } })).toString('base64url'))).toThrow(/cursor/);
  });

  it('counts by status across pages', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Count: 2, LastEvaluatedKey: { PK: 'x' } })
      .resolves({ Count: 1 });
    const counts = await repo.countByStatus();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(2 + 1 + 5); // first status paged (2+1), others 1 each
  });

  it('separates the job record from its timeline events', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { PK: 'JOB#1', SK: 'EVT#2026-10-10T00:00:02Z#aa', at: '2026-10-10T00:00:02Z', event: 'STARTED', message: '' },
        { PK: 'JOB#1', SK: 'EVT#2026-10-10T00:00:01Z#bb', at: '2026-10-10T00:00:01Z', event: 'SUBMITTED', message: '' },
        repo.jobToItem(job),
      ],
    });
    const { job: j, events } = await repo.getJobWithEvents(job.jobId);
    expect(j?.jobId).toBe(job.jobId);
    expect(events.map((e) => e.event)).toEqual(['SUBMITTED', 'STARTED']);
  });

  it('uses strongly consistent reads for the job record', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await repo.getJob('x')).toBeNull();
    expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });
});
