/**
 * Error taxonomy.
 *
 * - HttpError: returned to API callers with a status code.
 * - NonRetryableJobError: the input or parameters are wrong. Retrying the same job unchanged
 *   cannot succeed, so the worker marks it FAILED immediately (no SQS retries, no DLQ).
 * - Any other Error thrown while processing is treated as RETRYABLE: the worker schedules a
 *   retry with backoff and, after MAX_ATTEMPTS, SQS moves the message to the dead-letter queue.
 */

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NonRetryableJobError extends Error {
  constructor(
    message: string,
    public readonly code = 'INVALID_INPUT',
  ) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

/** Thrown by the fault-injection control. Retryable on purpose. */
export class InjectedFaultError extends Error {
  public readonly code = 'INJECTED_FAULT';
  constructor(message: string) {
    super(message);
    this.name = 'InjectedFaultError';
  }
}

export function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown };
    if (typeof e.code === 'string') return e.code;
    if (typeof e.name === 'string' && e.name !== 'Error') return e.name;
  }
  return 'PROCESSING_ERROR';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface ZodLikeError {
  name: 'ZodError';
  issues: { path: (string | number)[]; message: string }[];
}

/**
 * Detects schema-validation errors by shape rather than `instanceof`, because the shared
 * package and the backend may each load their own copy of zod.
 */
export function isZodError(err: unknown): err is ZodLikeError {
  return Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'ZodError' && Array.isArray((err as { issues?: unknown }).issues));
}
