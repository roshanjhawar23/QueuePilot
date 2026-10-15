import { randomUUID } from 'node:crypto';
import { CreateBackupRequestSchema, RestoreBackupRequestSchema, TERMINAL_STATUSES } from '@queuepilot/shared';
import type { BackupRecord, Job, JobEvent, ListBackupsResponse, RestoreBackupResponse } from '@queuepilot/shared';
import { HttpError } from '../lib/errors.js';
import { json, parseJsonBody, pathParam } from '../lib/http.js';
import * as repo from '../lib/jobsRepo.js';
import { getObjectBytes, isNotFound, putObject, sha256Hex } from '../lib/storage.js';
import type { RouteHandler } from './context.js';

/**
 * Backup & restore of selected job records.
 *
 * A backup is a JSON snapshot (job records + their timelines) written to S3 under backups/.
 * Its SHA-256 hash is stored in DynamoDB; restore refuses a snapshot whose hash no longer matches.
 * Backups contain records only - input/output files stay in S3 under their own lifecycle rules.
 */

export interface BackupSnapshot {
  format: 'queuepilot-job-backup';
  version: 1;
  backupId: string;
  label: string;
  createdAt: string;
  jobs: { job: Job; events: JobEvent[] }[];
}

/** POST /backups */
export const createBackup: RouteHandler = async ({ event, log }) => {
  const req = CreateBackupRequestSchema.parse(parseJsonBody(event));
  const ids = [...new Set(req.jobIds)];
  const found = await Promise.all(ids.map((id) => repo.getJobWithEvents(id)));
  const jobs = found.filter((f): f is { job: Job; events: JobEvent[] } => f.job !== null);
  const notFound = ids.filter((id) => !jobs.some((j) => j.job.jobId === id));
  if (jobs.length === 0) throw new HttpError(404, 'JOBS_NOT_FOUND', 'None of the selected jobs exist.');

  const createdAt = new Date().toISOString();
  const backupId = randomUUID();
  const snapshot: BackupSnapshot = {
    format: 'queuepilot-job-backup',
    version: 1,
    backupId,
    label: req.label?.trim() || `Backup of ${jobs.length} job(s)`,
    createdAt,
    jobs,
  };
  const body = JSON.stringify(snapshot, null, 2);
  const s3Key = `backups/${backupId}.json`;
  await putObject(s3Key, body, 'application/json');

  const record: BackupRecord = {
    backupId,
    label: snapshot.label,
    jobIds: jobs.map((j) => j.job.jobId),
    jobCount: jobs.length,
    eventCount: jobs.reduce((s, j) => s + j.events.length, 0),
    s3Key,
    sha256: sha256Hex(body),
    sizeBytes: Buffer.byteLength(body),
    createdAt,
  };
  await repo.putBackup(record);
  log.info('backup created', { backupId, jobs: record.jobCount });
  return json(201, { backup: record, notFound });
};

/** GET /backups */
export const listBackups: RouteHandler = async () => {
  const body: ListBackupsResponse = { items: await repo.listBackups() };
  return json(200, body);
};

/**
 * A job that was in flight when backed up has no SQS message any more, so it is restored as
 * FAILED (retryable) rather than as QUEUED/PROCESSING, which would leave it stuck forever.
 */
export function prepareRestoredJob(job: Job, backupId: string, now: string): Job {
  const restored: Job = { ...job, restoredFromBackupId: backupId, updatedAt: now };
  delete restored.leaseUntil;
  delete restored.nextAttemptAt;
  if (!TERMINAL_STATUSES.includes(job.status)) {
    restored.status = 'FAILED';
    restored.finishedAt = now;
    restored.lastError = {
      code: 'RESTORED_IN_FLIGHT',
      message: `The job was ${job.status} when it was backed up, so it was restored as FAILED. Use Retry to run it again.`,
      retryable: true,
      at: now,
    };
  }
  return restored;
}

/** POST /backups/{backupId}/restore */
export const restoreBackup: RouteHandler = async ({ event, log }) => {
  const backupId = pathParam(event, 'backupId');
  const req = RestoreBackupRequestSchema.parse(parseJsonBody(event));
  const record = await repo.getBackup(backupId);
  if (!record) throw new HttpError(404, 'BACKUP_NOT_FOUND', 'Backup not found.');

  let bytes: Uint8Array;
  try {
    bytes = await getObjectBytes(record.s3Key);
  } catch (err) {
    if (isNotFound(err)) throw new HttpError(410, 'BACKUP_FILE_MISSING', 'The backup file is no longer in S3 (backups expire after 30 days).');
    throw err;
  }
  if (sha256Hex(bytes) !== record.sha256) {
    throw new HttpError(422, 'INTEGRITY_CHECK_FAILED', 'The backup file does not match its recorded SHA-256 hash. It will not be restored.');
  }
  const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8')) as BackupSnapshot;
  if (snapshot.format !== 'queuepilot-job-backup' || snapshot.version !== 1) {
    throw new HttpError(422, 'UNSUPPORTED_BACKUP', 'Unsupported backup format.');
  }

  const wanted = req.jobIds ? new Set(req.jobIds) : null;
  const restored: string[] = [];
  const skipped: RestoreBackupResponse['skipped'] = [];
  const now = new Date().toISOString();

  for (const entry of snapshot.jobs) {
    const { job, events } = entry;
    if (wanted && !wanted.has(job.jobId)) continue;
    if (req.mode === 'overwrite') {
      const current = await repo.getJob(job.jobId);
      if (current && !TERMINAL_STATUSES.includes(current.status)) {
        skipped.push({ jobId: job.jobId, reason: `The current job is ${current.status}; active jobs are never overwritten.` });
        continue;
      }
      if (current) await repo.deleteJobRecords(job.jobId);
    }
    const restoredEvents: JobEvent[] = [
      ...events,
      { at: now, event: 'RESTORED', message: `Restored from backup "${snapshot.label}" (${req.mode}).`, details: { backupId } },
    ];
    const ok = await repo.putRestoredJob(prepareRestoredJob(job, backupId, now), restoredEvents, req.mode === 'missing-only');
    if (ok) restored.push(job.jobId);
    else skipped.push({ jobId: job.jobId, reason: 'The job already exists (mode: missing-only).' });
  }
  if (wanted) {
    for (const id of wanted) if (!snapshot.jobs.some((j) => j.job.jobId === id)) skipped.push({ jobId: id, reason: 'Not in this backup.' });
  }
  if (restored.length > 0) await repo.markBackupRestored(backupId, now);
  log.info('backup restored', { backupId, restored: restored.length, skipped: skipped.length, mode: req.mode });
  const body: RestoreBackupResponse = { backupId, restored, skipped };
  return json(200, body);
};
