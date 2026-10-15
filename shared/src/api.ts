import { z } from 'zod';
import { FailModeSchema, JobStatusSchema, JobTypeSchema, MAX_UPLOAD_BYTES } from './job.js';
import type { Job, JobEvent, JobStatus } from './job.js';

/** HTTP API contract shared by the Lambda router and the React client. */

// POST /uploads
export const CreateUploadRequestSchema = z
  .object({
    fileName: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w\- .()]+\.(csv|txt|md|json)$/i, 'File name must end in .csv, .txt, .md or .json and use simple characters'),
    sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES, `Files must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller`),
  })
  .strict();
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

export interface CreateUploadResponse {
  uploadId: string;
  inputKey: string;
  /** S3 presigned POST: send a multipart/form-data POST to `url` with `fields` + the file as the last field named "file". */
  url: string;
  fields: Record<string, string>;
  maxBytes: number;
  expiresInSeconds: number;
}

// POST /jobs
export const CreateJobRequestSchema = z
  .object({
    type: JobTypeSchema,
    inputKey: z.string().regex(/^inputs\/[0-9a-f-]{36}\/[\w\- .()]+$/i, 'inputKey must come from POST /uploads'),
    params: z.record(z.unknown()).optional(),
    failMode: FailModeSchema.default('none'),
  })
  .strict();
export type CreateJobRequest = z.input<typeof CreateJobRequestSchema>;

export interface CreateJobResponse {
  job: Job;
  idempotentReplay: boolean;
}

// GET /jobs
export const ListJobsQuerySchema = z.object({
  status: JobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(2000).optional(),
});
export interface ListJobsResponse {
  items: Job[];
  nextCursor: string | null;
}

// GET /jobs/{jobId}
export interface JobDetailResponse {
  job: Job;
  events: JobEvent[];
  downloads: { name: string; url: string; available: boolean; sizeBytes: number }[];
  leaseExpired: boolean;
}

// POST /jobs/{jobId}/retry
export const RetryJobRequestSchema = z
  .object({
    /** Corrected parameters (validated against the job type). Omit to keep the current ones. */
    params: z.record(z.unknown()).optional(),
    /** Change the fault-injection mode, e.g. from "permanent" to "none" to "fix" the job. */
    failMode: FailModeSchema.optional(),
  })
  .strict();
export type RetryJobRequest = z.infer<typeof RetryJobRequestSchema>;

// GET /system/metrics
export interface QueueDepth {
  visible: number;
  inFlight: number;
  delayed: number;
}
export interface SystemMetricsResponse {
  queue: QueueDepth;
  dlq: QueueDepth;
  statusCounts: Record<JobStatus, number>;
  config: { maxAttempts: number; maxUploadBytes: number; workerTimeoutSeconds: number; region: string };
  sampledAt: string;
}

// GET /dlq/messages
export interface DlqMessagePreview {
  messageId: string;
  jobId: string | null;
  dispatchId: string | null;
  sentAt: string | null;
  receiveCount: number;
  /** true when the job has been re-dispatched since; redriving this message will be safely ignored. */
  stale: boolean;
  jobStatus: JobStatus | 'MISSING' | null;
}
export interface DlqMessagesResponse {
  messages: DlqMessagePreview[];
  note: string;
}

// POST/GET /dlq/redrive
export interface RedriveTask {
  taskHandle: string | null;
  status: string;
  approximateNumberOfMessagesMoved: number;
  approximateNumberOfMessagesToMove: number | null;
  startedAt: string | null;
  failureReason: string | null;
}
export interface RedriveStatusResponse {
  tasks: RedriveTask[];
}

// Backups
export const CreateBackupRequestSchema = z
  .object({
    jobIds: z.array(z.string().uuid()).min(1).max(50),
    label: z.string().max(80).optional(),
  })
  .strict();
export type CreateBackupRequest = z.infer<typeof CreateBackupRequestSchema>;

export interface BackupRecord {
  backupId: string;
  label: string;
  jobIds: string[];
  jobCount: number;
  eventCount: number;
  s3Key: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  lastRestoredAt?: string;
}
export interface ListBackupsResponse {
  items: BackupRecord[];
}

export const RestoreBackupRequestSchema = z
  .object({
    /** missing-only: restore jobs that no longer exist. overwrite: replace current records with the snapshot. */
    mode: z.enum(['missing-only', 'overwrite']).default('missing-only'),
    jobIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();
export type RestoreBackupRequest = z.input<typeof RestoreBackupRequestSchema>;

export interface RestoreBackupResponse {
  backupId: string;
  restored: string[];
  skipped: { jobId: string; reason: string }[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
