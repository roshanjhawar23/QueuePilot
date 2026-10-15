import { randomBytes } from 'node:crypto';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { JOB_STATUSES } from '@queuepilot/shared';
import type { BackupRecord, Job, JobEvent, JobStatus } from '@queuepilot/shared';
import { ddb } from './aws.js';
import { getConfig } from './config.js';
import { HttpError } from './errors.js';

/**
 * Single-table DynamoDB design.
 *
 *   PK            SK                     What
 *   JOB#<id>      META                   the job record
 *   JOB#<id>      EVT#<iso time>#<rand>  one timeline event (attempt started, failed, ...)
 *   IDEM#<key>    META                   idempotency record -> jobId (expires after 24 h)
 *   BACKUP#<id>   META                   backup metadata (the snapshot itself is in S3)
 *
 *   GSI1 (GSI1PK, GSI1SK): "JOBS" / createdAt     -> newest jobs first (job explorer)
 *                          "BACKUPS" / createdAt  -> backup list
 *   GSI2 (GSI2PK, GSI2SK): "STATUS#<status>" / updatedAt -> filter by status, count by status
 *
 * Every item has `expiresAt` (epoch seconds) - DynamoDB TTL deletes it automatically.
 */

type Item = Record<string, NativeAttributeValue>;
const KEY_ATTRS = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'expiresAt', 'entity', 'requestHash'];

export const jobPk = (jobId: string) => `JOB#${jobId}`;
const META = 'META';

function ttl(days: number, from = Date.now()): number {
  return Math.floor(from / 1000) + days * 86_400;
}

function strip<T>(item: Item): T {
  const out: Item = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.includes(k)) out[k] = v;
  return out as T;
}

export function jobToItem(job: Job): Item {
  return {
    PK: jobPk(job.jobId),
    SK: META,
    entity: 'job',
    GSI1PK: 'JOBS',
    GSI1SK: `${job.createdAt}#${job.jobId}`,
    GSI2PK: `STATUS#${job.status}`,
    GSI2SK: `${job.updatedAt}#${job.jobId}`,
    expiresAt: ttl(getConfig().jobTtlDays),
    ...job,
  };
}

export function eventToItem(jobId: string, event: JobEvent): Item {
  return {
    PK: jobPk(jobId),
    SK: `EVT#${event.at}#${randomBytes(3).toString('hex')}`,
    entity: 'event',
    expiresAt: ttl(getConfig().jobTtlDays),
    ...event,
  };
}

export function isConditionalFailure(err: unknown): boolean {
  return (
    err instanceof ConditionalCheckFailedException ||
    (err as { name?: string })?.name === 'ConditionalCheckFailedException'
  );
}

function table(): string {
  return getConfig().tableName;
}

// ---------- Cursor encoding for pagination ----------

export function encodeCursor(key: Item | undefined): string | null {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null;
}

export function decodeCursor(cursor: string | undefined): Item | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    for (const v of Object.values(parsed)) if (typeof v !== 'string') throw new Error('bad value');
    return parsed as Item;
  } catch {
    throw new HttpError(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
  }
}

// ---------- Create (with idempotency) ----------

export interface IdempotencyRecord {
  jobId: string;
  requestHash: string;
}

/**
 * Creates the job, its SUBMITTED event and (optionally) the idempotency record in ONE transaction.
 * Returns false if the idempotency key was already used (the caller then returns the original job).
 */
export async function createJob(job: Job, event: JobEvent, idempotency?: { key: string; requestHash: string }): Promise<boolean> {
  const items: { Put: { TableName: string; Item: Item; ConditionExpression?: string } }[] = [
    { Put: { TableName: table(), Item: jobToItem(job), ConditionExpression: 'attribute_not_exists(PK)' } },
    { Put: { TableName: table(), Item: eventToItem(job.jobId, event) } },
  ];
  if (idempotency) {
    items.push({
      Put: {
        TableName: table(),
        Item: {
          PK: `IDEM#${idempotency.key}`,
          SK: META,
          entity: 'idempotency',
          jobId: job.jobId,
          requestHash: idempotency.requestHash,
          expiresAt: ttl(1),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (err) {
    if (idempotency && err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons ?? [];
      if (reasons[2]?.Code === 'ConditionalCheckFailed') return false;
    }
    throw err;
  }
}

export async function getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: table(), Key: { PK: `IDEM#${key}`, SK: META }, ConsistentRead: true }));
  if (!res.Item) return null;
  return { jobId: res.Item.jobId as string, requestHash: res.Item.requestHash as string };
}

// ---------- Read ----------

export async function getJob(jobId: string, consistent = true): Promise<Job | null> {
  const res = await ddb.send(new GetCommand({ TableName: table(), Key: { PK: jobPk(jobId), SK: META }, ConsistentRead: consistent }));
  return res.Item ? strip<Job>(res.Item) : null;
}

export async function getJobs(jobIds: string[]): Promise<Map<string, Job>> {
  const out = new Map<string, Job>();
  const unique = [...new Set(jobIds)];
  for (let i = 0; i < unique.length; i += 100) {
    let keys: Item[] | undefined = unique.slice(i, i + 100).map((id) => ({ PK: jobPk(id), SK: META }));
    for (let tries = 0; keys && keys.length > 0 && tries < 5; tries++) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: keys } } }));
      for (const item of res.Responses?.[table()] ?? []) {
        const job = strip<Job>(item);
        out.set(job.jobId, job);
      }
      keys = res.UnprocessedKeys?.[table()]?.Keys as Item[] | undefined;
    }
  }
  return out;
}

/** Job record + timeline events (oldest first). */
export async function getJobWithEvents(jobId: string): Promise<{ job: Job | null; events: JobEvent[] }> {
  let job: Job | null = null;
  const events: JobEvent[] = [];
  let startKey: Item | undefined;
  let pages = 0;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': jobPk(jobId) },
        ExclusiveStartKey: startKey,
        ConsistentRead: true,
      }),
    );
    for (const item of res.Items ?? []) {
      if (item.SK === META) job = strip<Job>(item);
      else events.push(strip<JobEvent>(item));
    }
    startKey = res.LastEvaluatedKey;
    pages++;
  } while (startKey && pages < 5);
  events.sort((a, b) => a.at.localeCompare(b.at));
  return { job, events };
}

export async function listJobs(opts: { status?: JobStatus; limit: number; cursor?: string }): Promise<{ items: Job[]; nextCursor: string | null }> {
  const byStatus = Boolean(opts.status);
  const res = await ddb.send(
    new QueryCommand({
      TableName: table(),
      IndexName: byStatus ? 'GSI2' : 'GSI1',
      KeyConditionExpression: byStatus ? 'GSI2PK = :pk' : 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': byStatus ? `STATUS#${opts.status}` : 'JOBS' },
      ScanIndexForward: false,
      Limit: opts.limit,
      ExclusiveStartKey: decodeCursor(opts.cursor),
    }),
  );
  return { items: (res.Items ?? []).map((i) => strip<Job>(i)), nextCursor: encodeCursor(res.LastEvaluatedKey) };
}

export async function countByStatus(): Promise<Record<JobStatus, number>> {
  const entries = await Promise.all(
    JOB_STATUSES.map(async (status) => {
      let count = 0;
      let startKey: Item | undefined;
      do {
        const res = await ddb.send(
          new QueryCommand({
            TableName: table(),
            IndexName: 'GSI2',
            KeyConditionExpression: 'GSI2PK = :pk',
            ExpressionAttributeValues: { ':pk': `STATUS#${status}` },
            Select: 'COUNT',
            ExclusiveStartKey: startKey,
          }),
        );
        count += res.Count ?? 0;
        startKey = res.LastEvaluatedKey;
      } while (startKey);
      return [status, count] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<JobStatus, number>;
}

// ---------- Events ----------

export async function addEvent(jobId: string, event: JobEvent): Promise<void> {
  await ddb.send(new PutCommand({ TableName: table(), Item: eventToItem(jobId, event) }));
}

// ---------- State transitions (all conditional = optimistic concurrency) ----------

/**
 * Applies `set` to the job only if its status and dispatchId still match what the caller observed.
 * Status changes also move the item in GSI2. Returns the updated job, or null if the condition failed.
 */
export async function transitionJob(
  jobId: string,
  expected: { status: JobStatus; dispatchId: string; leaseExpiredBefore?: string },
  set: Partial<Job> & { status?: JobStatus },
  remove: (keyof Job)[] = [],
): Promise<Job | null> {
  const now = set.updatedAt ?? new Date().toISOString();
  const values: Item = { ':expStatus': expected.status, ':expDispatch': expected.dispatchId };
  const names: Record<string, string> = { '#status': 'status' };
  const sets: string[] = [];
  const fields: Item = { ...set, updatedAt: now };
  if (set.status) {
    fields.GSI2PK = `STATUS#${set.status}`;
    fields.GSI2SK = `${now}#${jobId}`;
  } else {
    // keep GSI2 sort key in step with updatedAt
    fields.GSI2SK = `${now}#${jobId}`;
  }
  Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .forEach(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`#f${i} = :v${i}`);
  });
  let update = `SET ${sets.join(', ')}`;
  if (remove.length) {
    update += ` REMOVE ${remove.map((k, i) => {
      names[`#r${i}`] = k;
      return `#r${i}`;
    }).join(', ')}`;
  }
  let condition = '#status = :expStatus AND dispatchId = :expDispatch';
  if (expected.leaseExpiredBefore) {
    condition += ' AND (attribute_not_exists(leaseUntil) OR leaseUntil < :leaseNow)';
    values[':leaseNow'] = expected.leaseExpiredBefore;
  }
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: jobPk(jobId), SK: META },
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return res.Attributes ? strip<Job>(res.Attributes) : null;
  } catch (err) {
    if (isConditionalFailure(err)) return null;
    throw err;
  }
}

// ---------- Delete / restore ----------

async function batchWrite(requests: Item[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let chunk: Item[] | undefined = requests.slice(i, i + 25);
    for (let tries = 0; chunk && chunk.length > 0; tries++) {
      if (tries >= 6) throw new Error('DynamoDB BatchWrite did not complete after retries');
      if (tries > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** tries));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table()]: chunk } }));
      chunk = res.UnprocessedItems?.[table()] as Item[] | undefined;
    }
  }
}

/** Deletes the job record and all of its events (S3 objects are left to the bucket lifecycle rule). */
export async function deleteJobRecords(jobId: string): Promise<number> {
  const keys: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': jobPk(jobId) },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      }),
    );
    keys.push(...(res.Items ?? []).map((i) => ({ PK: i.PK, SK: i.SK })));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  await batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
  return keys.length;
}

/** Writes a job record from a backup. With onlyIfMissing, an existing job is left untouched. */
export async function putRestoredJob(job: Job, events: JobEvent[], onlyIfMissing: boolean): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: jobToItem(job),
        ConditionExpression: onlyIfMissing ? 'attribute_not_exists(PK)' : undefined,
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
  await batchWrite(events.map((e) => ({ PutRequest: { Item: eventToItem(job.jobId, e) } })));
  return true;
}

// ---------- Backups ----------

export async function putBackup(b: BackupRecord): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: `BACKUP#${b.backupId}`,
        SK: META,
        entity: 'backup',
        GSI1PK: 'BACKUPS',
        GSI1SK: `${b.createdAt}#${b.backupId}`,
        expiresAt: ttl(getConfig().backupTtlDays),
        ...b,
      },
    }),
  );
}

export async function getBackup(backupId: string): Promise<BackupRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: table(), Key: { PK: `BACKUP#${backupId}`, SK: META } }));
  return res.Item ? strip<BackupRecord>(res.Item) : null;
}

export async function listBackups(limit = 50): Promise<BackupRecord[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'BACKUPS' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map((i) => strip<BackupRecord>(i));
}

export async function markBackupRestored(backupId: string, at: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: `BACKUP#${backupId}`, SK: META },
      UpdateExpression: 'SET lastRestoredAt = :at',
      ExpressionAttributeValues: { ':at': at },
    }),
  );
}

export async function deleteItem(pk: string, sk = META): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: table(), Key: { PK: pk, SK: sk } }));
}
