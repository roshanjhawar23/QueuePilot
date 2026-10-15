import type { FailMode, JobStatus, JobType } from '@queuepilot/shared';

export const STATUS_LABELS: Record<JobStatus, string> = {
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  RETRY_SCHEDULED: 'Retry scheduled',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  DEAD_LETTERED: 'Dead-lettered',
};

export const STATUS_HELP: Record<JobStatus, string> = {
  QUEUED: 'Waiting in the SQS queue for a worker.',
  PROCESSING: 'A worker Lambda is running this job now.',
  RETRY_SCHEDULED: 'An attempt failed; SQS will deliver it again after a backoff delay.',
  SUCCEEDED: 'Finished. Results are in S3.',
  FAILED: 'The input or parameters are wrong. Retrying unchanged would not help, so fix and retry.',
  DEAD_LETTERED: 'Every attempt failed. The message is parked in the dead-letter queue.',
};

export const TYPE_LABELS: Record<JobType, string> = {
  'csv.summary': 'CSV summary',
  'text.analytics': 'Text analytics',
  'data.validate': 'Data validation',
};

export const FAIL_MODE_LABELS: Record<FailMode, string> = {
  none: 'No fault',
  transient: 'Transient fault',
  permanent: 'Permanent fault',
  slow: 'Slow task (timeout)',
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
