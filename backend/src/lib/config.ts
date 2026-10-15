/**
 * Runtime configuration, read from Lambda environment variables that the SAM template sets.
 * Read lazily (not at import time) so unit tests can control the values.
 */
export interface Config {
  region: string;
  tableName: string;
  dataBucket: string;
  queueUrl: string;
  queueArn: string;
  dlqUrl: string;
  dlqArn: string;
  maxAttempts: number;
  /** Delay (seconds) before attempt 2, attempt 3, ... Applied with SQS ChangeMessageVisibility. */
  backoffSeconds: number[];
  workerTimeoutSeconds: number;
  /** How long a worker "owns" a job after claiming it. Must exceed the worker timeout. */
  leaseSeconds: number;
  jobTtlDays: number;
  backupTtlDays: number;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

export function getConfig(): Config {
  const workerTimeoutSeconds = int('WORKER_TIMEOUT_SECONDS', 15);
  return {
    region: process.env.AWS_REGION ?? 'us-east-1',
    tableName: required('TABLE_NAME'),
    dataBucket: required('DATA_BUCKET'),
    queueUrl: required('QUEUE_URL'),
    queueArn: required('QUEUE_ARN'),
    dlqUrl: required('DLQ_URL'),
    dlqArn: required('DLQ_ARN'),
    maxAttempts: int('MAX_ATTEMPTS', 3),
    backoffSeconds: (process.env.BACKOFF_SECONDS ?? '5,20').split(',').map((s) => Number(s.trim())),
    workerTimeoutSeconds,
    leaseSeconds: workerTimeoutSeconds + 5,
    jobTtlDays: int('JOB_TTL_DAYS', 7),
    backupTtlDays: int('BACKUP_TTL_DAYS', 30),
    uploadUrlTtlSeconds: 300,
    downloadUrlTtlSeconds: 900,
  };
}
