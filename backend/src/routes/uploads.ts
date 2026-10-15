import { randomUUID } from 'node:crypto';
import { CONTENT_TYPES, CreateUploadRequestSchema, MAX_UPLOAD_BYTES, fileExtension } from '@queuepilot/shared';
import type { CreateUploadResponse } from '@queuepilot/shared';
import { getConfig } from '../lib/config.js';
import { json, parseJsonBody } from '../lib/http.js';
import { presignUpload } from '../lib/storage.js';
import type { RouteHandler } from './context.js';

/** POST /uploads -> a short-lived S3 presigned POST so the browser uploads directly to S3. */
export const createUpload: RouteHandler = async ({ event, log }) => {
  const req = CreateUploadRequestSchema.parse(parseJsonBody(event));
  const uploadId = randomUUID();
  const safeName = req.fileName.trim().replace(/\s+/g, '_');
  const inputKey = `inputs/${uploadId}/${safeName}`;
  const contentType = CONTENT_TYPES[fileExtension(safeName)]!;
  const post = await presignUpload(inputKey, contentType);
  log.info('upload presigned', { uploadId, inputKey, declaredBytes: req.sizeBytes });
  const body: CreateUploadResponse = {
    uploadId,
    inputKey,
    url: post.url,
    fields: post.fields,
    maxBytes: MAX_UPLOAD_BYTES,
    expiresInSeconds: getConfig().uploadUrlTtlSeconds,
  };
  return json(201, body);
};
