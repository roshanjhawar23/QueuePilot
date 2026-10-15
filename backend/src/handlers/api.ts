import type { Context } from 'aws-lambda';
import { HttpError } from '../lib/errors.js';
import { errorResponse } from '../lib/http.js';
import type { HttpEvent, HttpResult } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { createBackup, listBackups, restoreBackup } from '../routes/backups.js';
import type { RouteHandler } from '../routes/context.js';
import { createJob, deleteJob, getJobDetail, listJobs, retryJob } from '../routes/jobs.js';
import { dlqMessages, dlqRedriveStatus, health, startDlqRedrive, systemMetrics } from '../routes/system.js';
import { createUpload } from '../routes/uploads.js';

/**
 * One Lambda function serves every API route. API Gateway (HTTP API) passes the matched
 * route in `event.routeKey`, e.g. "GET /jobs/{jobId}", so the router is a simple lookup.
 */
export const routes: Record<string, RouteHandler> = {
  'GET /health': health,
  'POST /uploads': createUpload,
  'POST /jobs': createJob,
  'GET /jobs': listJobs,
  'GET /jobs/{jobId}': getJobDetail,
  'DELETE /jobs/{jobId}': deleteJob,
  'POST /jobs/{jobId}/retry': retryJob,
  'GET /system/metrics': systemMetrics,
  'GET /dlq/messages': dlqMessages,
  'POST /dlq/redrive': startDlqRedrive,
  'GET /dlq/redrive': dlqRedriveStatus,
  'POST /backups': createBackup,
  'GET /backups': listBackups,
  'POST /backups/{backupId}/restore': restoreBackup,
};

export const handler = async (event: HttpEvent, context?: Context): Promise<HttpResult> => {
  const requestId = event.requestContext?.requestId ?? context?.awsRequestId ?? 'local';
  const log = logger.child({ fn: 'api', requestId, route: event.routeKey });
  const started = Date.now();
  try {
    const route = routes[event.routeKey];
    if (!route) throw new HttpError(404, 'ROUTE_NOT_FOUND', `No route for ${event.routeKey}`);
    const res = await route({ event, requestId, log });
    log.info('request', { status: res.statusCode, ms: Date.now() - started });
    return res;
  } catch (err) {
    const res = errorResponse(err, requestId, log);
    log.info('request', { status: res.statusCode, ms: Date.now() - started });
    return res;
  }
};
