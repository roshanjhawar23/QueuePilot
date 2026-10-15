import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ApiErrorBody } from '@queuepilot/shared';
import { HttpError, isZodError } from './errors.js';
import type { Logger } from './logger.js';

export type HttpEvent = APIGatewayProxyEventV2;
export type HttpResult = APIGatewayProxyStructuredResultV2;

export function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

const MAX_BODY_BYTES = 64 * 1024;

export function parseJsonBody(event: HttpEvent): unknown {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

export function header(event: HttpEvent, name: string): string | undefined {
  // HTTP API lower-cases header names.
  return event.headers?.[name.toLowerCase()];
}

export function pathParam(event: HttpEvent, name: string): string {
  const v = event.pathParameters?.[name];
  if (!v || !/^[0-9a-f-]{36}$/i.test(v)) throw new HttpError(400, 'INVALID_ID', `Path parameter ${name} must be a UUID.`);
  return v;
}

export function errorResponse(err: unknown, requestId: string, log: Logger): HttpResult {
  if (err instanceof HttpError) {
    if (err.statusCode >= 500) log.error('request failed', { err, code: err.code });
    const body: ApiErrorBody = { error: { code: err.code, message: err.message, details: err.details, requestId } };
    return json(err.statusCode, body);
  }
  if (isZodError(err)) {
    const body: ApiErrorBody = {
      error: {
        code: 'VALIDATION_ERROR',
        message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        details: err.issues,
        requestId,
      },
    };
    return json(400, body);
  }
  // Never leak internal details to the caller; they are in CloudWatch Logs under this requestId.
  log.error('unhandled error', { err });
  const body: ApiErrorBody = { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId } };
  return json(500, body);
}
