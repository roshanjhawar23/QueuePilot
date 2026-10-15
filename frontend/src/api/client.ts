import type {
  BackupRecord,
  CreateJobRequest,
  CreateJobResponse,
  CreateUploadResponse,
  DlqMessagesResponse,
  FailMode,
  Job,
  JobDetailResponse,
  JobStatus,
  ListBackupsResponse,
  ListJobsResponse,
  RedriveStatusResponse,
  RestoreBackupRequest,
  RestoreBackupResponse,
  SystemMetricsResponse,
} from '@queuepilot/shared';

/**
 * Typed client for the QueuePilot HTTP API. Every number the UI shows comes through here
 * from the deployed API - there is no mock or sample data in the frontend.
 */

const SESSION_KEY = 'queuepilot.session';

export interface Session {
  apiUrl: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function defaultApiUrl(): string {
  return (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';
}

/** Session is kept in sessionStorage: it disappears when the browser tab is closed. */
export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: session lives only in memory */
  }
}

export class QueuePilotClient {
  constructor(
    private readonly session: Session,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.session.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.session.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API. Check the API URL and your connection.');
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(res.status, 'UNAUTHORIZED', 'The access token was rejected. Sign in again with the demo token.');
      }
      if (res.status === 429) throw new ApiError(429, 'THROTTLED', 'Too many requests. The API is rate-limited; wait a moment.');
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed with status ${res.status}.`);
    }
    return data as T;
  }

  metrics() {
    return this.request<SystemMetricsResponse>('GET', '/system/metrics');
  }

  createUpload(fileName: string, sizeBytes: number) {
    return this.request<CreateUploadResponse>('POST', '/uploads', { fileName, sizeBytes });
  }

  /** Sends the file straight to S3 using the presigned POST (it never passes through Lambda). */
  async uploadToS3(upload: CreateUploadResponse, file: Blob): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    form.append('file', file); // must be the last field
    let res: Response;
    try {
      res = await this.fetchImpl(upload.url, { method: 'POST', body: form });
    } catch {
      throw new ApiError(0, 'UPLOAD_FAILED', 'The upload to S3 failed. Check your connection and the bucket CORS settings.');
    }
    if (!res.ok) {
      const text = await res.text();
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? 'UPLOAD_REJECTED';
      const message = code === 'EntityTooLarge' ? 'S3 rejected the file because it is larger than 5 MB.' : `S3 rejected the upload (${code}).`;
      throw new ApiError(res.status, code, message);
    }
  }

  createJob(req: CreateJobRequest, idempotencyKey: string) {
    return this.request<CreateJobResponse>('POST', '/jobs', req, { 'idempotency-key': idempotencyKey });
  }

  listJobs(opts: { status?: JobStatus; limit?: number; cursor?: string | null } = {}) {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    q.set('limit', String(opts.limit ?? 20));
    if (opts.cursor) q.set('cursor', opts.cursor);
    return this.request<ListJobsResponse>('GET', `/jobs?${q.toString()}`);
  }

  getJob(jobId: string) {
    return this.request<JobDetailResponse>('GET', `/jobs/${encodeURIComponent(jobId)}`);
  }

  deleteJob(jobId: string) {
    return this.request<{ jobId: string; deletedItems: number }>('DELETE', `/jobs/${encodeURIComponent(jobId)}`);
  }

  retryJob(jobId: string, body: { params?: Record<string, unknown>; failMode?: FailMode } = {}) {
    return this.request<{ job: Job }>('POST', `/jobs/${encodeURIComponent(jobId)}/retry`, body);
  }

  dlqMessages() {
    return this.request<DlqMessagesResponse>('GET', '/dlq/messages');
  }

  startRedrive() {
    return this.request<{ taskHandle: string; approximateMessages: number }>('POST', '/dlq/redrive');
  }

  redriveStatus() {
    return this.request<RedriveStatusResponse>('GET', '/dlq/redrive');
  }

  createBackup(jobIds: string[], label?: string) {
    return this.request<{ backup: BackupRecord; notFound: string[] }>('POST', '/backups', { jobIds, label });
  }

  listBackups() {
    return this.request<ListBackupsResponse>('GET', '/backups');
  }

  restoreBackup(backupId: string, body: RestoreBackupRequest) {
    return this.request<RestoreBackupResponse>('POST', `/backups/${encodeURIComponent(backupId)}/restore`, body);
  }
}
