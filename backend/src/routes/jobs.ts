import { createHash, randomUUID } from 'node:crypto';
import {
  ACCEPTED_EXTENSIONS,
  CreateJobRequestSchema,
  ListJobsQuerySchema,
  MAX_UPLOAD_BYTES,
  RetryJobRequestSchema,
  fileExtension,
  parseJobParams,
} from '@queuepilot/shared';
import type { CreateJobResponse, Job, JobDetailResponse, JobParams, ListJobsResponse } from '@queuepilot/shared';
import { retryBlockedReason } from '../lib/claim.js';
import { getConfig } from '../lib/config.js';
import { HttpError, isZodError } from '../lib/errors.js';
import { header, json, parseJsonBody, pathParam } from '../lib/http.js';
import * as repo from '../lib/jobsRepo.js';
import { emitMetric } from '../lib/metrics.js';
import { enqueueJob } from '../lib/queue.js';
import { headObject, presignDownload } from '../lib/storage.js';
import type { RouteHandler } from './context.js';

function validateParams(type: Job['type'], params: unknown): JobParams {
  try {
    return parseJobParams(type, params);
  } catch (err) {
    if (isZodError(err)) {
      throw new HttpError(
        400,
        'INVALID_PARAMS',
        `Invalid parameters for ${type}: ` + err.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
        err.issues,
      );
    }
    throw err;
  }
}

/** Sends the job to SQS. If SQS is unreachable the job is marked FAILED (retryable) instead of silently stuck. */
async function dispatch(job: Job, ctxLog: { warn: (m: string, e?: Record<string, unknown>) => void }): Promise<Job> {
  try {
    await enqueueJob(job.jobId, job.dispatchId, job.type);
    return job;
  } catch (err) {
    ctxLog.warn('enqueue failed', { jobId: job.jobId, err });
    const at = new Date().toISOString();
    const failed = await repo.transitionJob(
      job.jobId,
      { status: 'QUEUED', dispatchId: job.dispatchId },
      { status: 'FAILED', updatedAt: at, finishedAt: at, lastError: { code: 'DISPATCH_FAILED', message: 'The job could not be sent to the queue. Use Retry.', retryable: true, at } },
    );
    await repo.addEvent(job.jobId, { at, event: 'DISPATCH_FAILED', message: 'Could not send the message to SQS.', dispatchId: job.dispatchId });
    throw new HttpError(503, 'QUEUE_UNAVAILABLE', 'The job was recorded but could not be queued. Retry it from the job page.', {
      jobId: (failed ?? job).jobId,
    });
  }
}

/** POST /jobs */
export const createJob: RouteHandler = async ({ event, log }) => {
  const req = CreateJobRequestSchema.parse(parseJsonBody(event));
  const fileName = req.inputKey.split('/').pop()!;
  const ext = fileExtension(fileName);
  if (!ACCEPTED_EXTENSIONS[req.type].includes(ext)) {
    throw new HttpError(400, 'UNSUPPORTED_FILE_TYPE', `${req.type} accepts ${ACCEPTED_EXTENSIONS[req.type].join(', ')} files, not ${ext}.`);
  }
  const params = validateParams(req.type, req.params);

  // Idempotency: the same key + same request returns the original job instead of creating a duplicate.
  const idemKey = header(event, 'idempotency-key');
  if (idemKey !== undefined && !/^[\w-]{8,100}$/.test(idemKey)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-100 letters, digits, "-" or "_".');
  }
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ type: req.type, inputKey: req.inputKey, params, failMode: req.failMode }))
    .digest('hex');

  const replay = async (): Promise<ReturnType<RouteHandler> | null> => {
    if (!idemKey) return null;
    const existing = await repo.getIdempotencyRecord(idemKey);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
    }
    const job = await repo.getJob(existing.jobId);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'The job for this Idempotency-Key no longer exists.');
    log.info('idempotent replay', { jobId: job.jobId });
    const body: CreateJobResponse = { job, idempotentReplay: true };
    return json(200, body);
  };
  const early = await replay();
  if (early) return early;

  // Verify the upload really exists in S3 (and double-check the size limit).
  const head = await headObject(req.inputKey);
  if (!head) {
    throw new HttpError(400, 'UPLOAD_NOT_FOUND', 'The uploaded file was not found. Upload the file first (upload links expire after 5 minutes).');
  }
  if (head.sizeBytes > MAX_UPLOAD_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', 'The file exceeds the 5 MB limit.');

  const now = new Date().toISOString();
  const job: Job = {
    jobId: randomUUID(),
    type: req.type,
    status: 'QUEUED',
    fileName,
    inputKey: req.inputKey,
    inputSizeBytes: head.sizeBytes,
    params,
    failMode: req.failMode,
    dispatchId: randomUUID(),
    cycleAttempts: 0,
    totalAttempts: 0,
    maxAttempts: getConfig().maxAttempts,
    retryCount: 0,
    outputs: [],
    createdAt: now,
    updatedAt: now,
  };
  const created = await repo.createJob(
    job,
    { at: now, event: 'SUBMITTED', message: `Job submitted (${job.type}${job.failMode !== 'none' ? `, fault injection: ${job.failMode}` : ''}).`, dispatchId: job.dispatchId },
    idemKey ? { key: idemKey, requestHash } : undefined,
  );
  if (!created) {
    // Lost a race with a concurrent request using the same key.
    const again = await replay();
    if (again) return again;
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'A request with this Idempotency-Key is still being processed.');
  }
  await dispatch(job, log);
  emitMetric('JobsSubmitted', 1);
  log.info('job submitted', { jobId: job.jobId, type: job.type, failMode: job.failMode });
  const body: CreateJobResponse = { job, idempotentReplay: false };
  return json(202, body);
};

/** GET /jobs?status=&limit=&cursor= */
export const listJobs: RouteHandler = async ({ event }) => {
  const q = ListJobsQuerySchema.parse(event.queryStringParameters ?? {});
  const res: ListJobsResponse = await repo.listJobs(q);
  return json(200, res);
};

/** GET /jobs/{jobId} */
export const getJobDetail: RouteHandler = async ({ event }) => {
  const jobId = pathParam(event, 'jobId');
  const { job, events } = await repo.getJobWithEvents(jobId);
  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
  const downloads = await Promise.all(
    job.outputs.map(async (o) => {
      const head = await headObject(o.key);
      return {
        name: o.name,
        sizeBytes: o.sizeBytes,
        available: head !== null,
        url: head ? await presignDownload(o.key, `${job.jobId.slice(0, 8)}-${o.name}`) : '',
      };
    }),
  );
  const leaseExpired = job.status === 'PROCESSING' && (!job.leaseUntil || Date.parse(job.leaseUntil) < Date.now());
  const body: JobDetailResponse = { job, events, downloads, leaseExpired };
  return json(200, body);
};

/** DELETE /jobs/{jobId} - removes the DynamoDB records (used to demonstrate backup/restore). */
export const deleteJob: RouteHandler = async ({ event, log }) => {
  const jobId = pathParam(event, 'jobId');
  const job = await repo.getJob(jobId);
  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
  const active = job.status === 'QUEUED' || job.status === 'RETRY_SCHEDULED' || (job.status === 'PROCESSING' && retryBlockedReason(job, new Date()) !== null);
  if (active) throw new HttpError(409, 'JOB_ACTIVE', 'Active jobs cannot be deleted. Wait until the job finishes.');
  const deleted = await repo.deleteJobRecords(jobId);
  log.info('job records deleted', { jobId, items: deleted });
  return json(200, { jobId, deletedItems: deleted });
};

/** POST /jobs/{jobId}/retry - re-dispatches a FAILED / DEAD_LETTERED / stuck job, optionally with corrected params. */
export const retryJob: RouteHandler = async ({ event, log }) => {
  const jobId = pathParam(event, 'jobId');
  const req = RetryJobRequestSchema.parse(parseJsonBody(event));
  const job = await repo.getJob(jobId);
  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
  const blocked = retryBlockedReason(job, new Date());
  if (blocked) throw new HttpError(409, 'RETRY_NOT_ALLOWED', blocked);

  if (!(await headObject(job.inputKey))) {
    throw new HttpError(409, 'INPUT_EXPIRED', 'The input file is no longer in S3 (uploads expire after 3 days). Upload it again as a new job.');
  }

  const params = req.params ? validateParams(job.type, { ...job.params, ...req.params }) : job.params;
  const failMode = req.failMode ?? job.failMode;
  const now = new Date().toISOString();
  const newDispatchId = randomUUID();
  const updated = await repo.transitionJob(
    jobId,
    { status: job.status, dispatchId: job.dispatchId },
    { status: 'QUEUED', dispatchId: newDispatchId, cycleAttempts: 0, retryCount: job.retryCount + 1, params, failMode, updatedAt: now },
    ['leaseUntil', 'finishedAt', 'nextAttemptAt'],
  );
  if (!updated) throw new HttpError(409, 'CONCURRENT_UPDATE', 'The job changed while retrying. Refresh and try again.');

  const changes: string[] = [];
  if (req.params) changes.push('parameters corrected');
  if (req.failMode && req.failMode !== job.failMode) changes.push(`fault injection ${job.failMode} -> ${req.failMode}`);
  await repo.addEvent(jobId, {
    at: now,
    event: 'RETRY_REQUESTED',
    message:
      `Manual retry #${updated.retryCount} from ${job.status}${changes.length ? ` (${changes.join(', ')})` : ''}.` +
      (job.status === 'DEAD_LETTERED' ? ' The old copy of this message in the DLQ is now stale and will be ignored if redriven.' : ''),
    dispatchId: newDispatchId,
    details: req.params ? { params } : undefined,
  });
  await dispatch(updated, log);
  log.info('job retried', { jobId, previousStatus: job.status });
  return json(202, { job: updated });
};
