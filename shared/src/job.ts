import { z } from 'zod';

/**
 * Shared job model used by BOTH the backend (Lambda) and the frontend (React).
 * Keeping one definition prevents the UI and the API from drifting apart.
 */

export const JOB_TYPES = ['csv.summary', 'text.analytics', 'data.validate'] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobTypeSchema>;

/**
 * Lifecycle:
 *   QUEUED -> PROCESSING -> SUCCEEDED
 *                 |-> RETRY_SCHEDULED -> PROCESSING ... (until attempts are exhausted)
 *                 |-> DEAD_LETTERED  (retryable error, all attempts used; message is in the SQS DLQ)
 *                 |-> FAILED         (non-retryable data/validation error; retrying unchanged would not help)
 */
export const JOB_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'RETRY_SCHEDULED',
  'SUCCEEDED',
  'FAILED',
  'DEAD_LETTERED',
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const TERMINAL_STATUSES: readonly JobStatus[] = ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'];

/**
 * Fault injection is a DEMO control. The worker really runs on Lambda and really fails;
 * the failure is simply triggered on purpose so retries and the DLQ can be shown live.
 */
export const FAIL_MODES = ['none', 'transient', 'permanent', 'slow'] as const;
export const FailModeSchema = z.enum(FAIL_MODES);
export type FailMode = z.infer<typeof FailModeSchema>;

export const FAIL_MODE_DESCRIPTIONS: Record<FailMode, string> = {
  none: 'No fault injected - the job runs normally.',
  transient: 'Fails on attempts 1 and 2, succeeds on attempt 3 (shows retry with backoff).',
  permanent: 'Fails on every attempt, then SQS moves the message to the dead-letter queue.',
  slow: 'Attempt 1 sleeps past the Lambda timeout (a real timeout); attempt 2 completes.',
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB hard limit (enforced by the S3 presigned POST policy)
export const MAX_ATTEMPTS = 3; // must match maxReceiveCount on the SQS redrive policy

/** File extensions accepted per job type. */
export const ACCEPTED_EXTENSIONS: Record<JobType, readonly string[]> = {
  'csv.summary': ['.csv'],
  'text.analytics': ['.txt', '.md'],
  'data.validate': ['.csv', '.json'],
};
export const ALL_ACCEPTED_EXTENSIONS = ['.csv', '.txt', '.md', '.json'] as const;

export const CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

export function fileExtension(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i === -1 ? '' : fileName.slice(i).toLowerCase();
}

// ---------- Job parameters (per type) ----------

export const CsvSummaryParamsSchema = z
  .object({
    delimiter: z.enum([',', ';', '\t', '|']).default(','),
    topN: z.number().int().min(1).max(25).default(5),
    /** If more than this percentage of data rows are malformed, the job FAILS (non-retryable). */
    maxMalformedPercent: z.number().min(0).max(100).default(20),
  })
  .strict();
export type CsvSummaryParams = z.infer<typeof CsvSummaryParamsSchema>;

export const TextAnalyticsParamsSchema = z
  .object({
    topN: z.number().int().min(1).max(50).default(10),
    longSentenceWords: z.number().int().min(5).max(200).default(30),
    wordsPerMinute: z.number().int().min(50).max(1000).default(200),
  })
  .strict();
export type TextAnalyticsParams = z.infer<typeof TextAnalyticsParamsSchema>;

export const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'date', 'email'] as const;
export const ValidationRuleSchema = z
  .object({
    field: z.string().min(1).max(100),
    required: z.boolean().optional(),
    type: z.enum(FIELD_TYPES).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    allowedValues: z.array(z.string()).max(100).optional(),
  })
  .strict()
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
    message: 'min must be less than or equal to max',
  });
export type ValidationRule = z.infer<typeof ValidationRuleSchema>;

export const DataValidateParamsSchema = z
  .object({
    rules: z.array(ValidationRuleSchema).min(1).max(50),
    delimiter: z.enum([',', ';', '\t', '|']).default(','),
  })
  .strict();
export type DataValidateParams = z.infer<typeof DataValidateParamsSchema>;

export const PARAM_SCHEMAS = {
  'csv.summary': CsvSummaryParamsSchema,
  'text.analytics': TextAnalyticsParamsSchema,
  'data.validate': DataValidateParamsSchema,
} as const;

export type JobParams = CsvSummaryParams | TextAnalyticsParams | DataValidateParams;

/** Validates and applies defaults. Throws a ZodError if invalid. */
export function parseJobParams(type: JobType, params: unknown): JobParams {
  return PARAM_SCHEMAS[type].parse(params ?? {});
}

// ---------- Records ----------

export interface OutputFile {
  name: string;
  key: string;
  contentType: string;
  sizeBytes: number;
}

export interface Job {
  jobId: string;
  type: JobType;
  status: JobStatus;
  fileName: string;
  inputKey: string;
  inputSizeBytes: number;
  params: JobParams;
  failMode: FailMode;
  /** Changes every time the job is (re)dispatched; stale SQS messages carry an old value and are discarded. */
  dispatchId: string;
  /** Attempts in the current dispatch cycle (reset on retry/redrive). */
  cycleAttempts: number;
  /** Attempts across the job's whole life. */
  totalAttempts: number;
  maxAttempts: number;
  retryCount: number;
  outputs: OutputFile[];
  resultSummary?: Record<string, unknown>;
  lastError?: { message: string; code: string; retryable: boolean; at: string };
  leaseUntil?: string;
  /** When a scheduled retry becomes visible in SQS again. */
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  restoredFromBackupId?: string;
}

export const JOB_EVENT_TYPES = [
  'SUBMITTED',
  'DISPATCH_FAILED',
  'STARTED',
  'ATTEMPT_FAILED',
  'RETRY_SCHEDULED',
  'SUCCEEDED',
  'FAILED',
  'DEAD_LETTERED',
  'REDRIVEN',
  'RETRY_REQUESTED',
  'DUPLICATE_DISCARDED',
  'STALE_MESSAGE_DISCARDED',
  'RESTORED',
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

export interface JobEvent {
  at: string;
  event: JobEventType;
  message: string;
  attempt?: number;
  dispatchId?: string;
  details?: Record<string, unknown>;
}
