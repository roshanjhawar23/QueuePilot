import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_UPLOAD_BYTES } from '@queuepilot/shared';
import { s3 } from './aws.js';
import { getConfig } from './config.js';

/**
 * S3 layout in the data bucket:
 *   inputs/<uploadId>/<fileName>   uploaded by the browser via presigned POST (expires after 3 days)
 *   outputs/<jobId>/<file>         written by the worker (expires after 3 days)
 *   backups/<backupId>.json        job-record snapshots (expire after 30 days)
 */

export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

export async function presignUpload(key: string, contentType: string) {
  const cfg = getConfig();
  // The policy is enforced by S3 itself: wrong key, wrong content type or > 5 MB is rejected.
  return createPresignedPost(s3, {
    Bucket: cfg.dataBucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: cfg.uploadUrlTtlSeconds,
  });
}

export async function headObject(key: string): Promise<{ sizeBytes: number; contentType?: string } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: getConfig().dataBucket, Key: key }));
    return { sizeBytes: Number(res.ContentLength ?? 0), contentType: res.ContentType };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: getConfig().dataBucket, Key: key }));
  if (!res.Body) throw new Error(`S3 object ${key} has no body`);
  return res.Body.transformToByteArray();
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function putObject(key: string, body: string, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: getConfig().dataBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // S3 verifies this checksum on upload and stores it, so corrupted writes are rejected.
      ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
    }),
  );
}

export async function presignDownload(key: string, fileName: string): Promise<string> {
  const cfg = getConfig();
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: cfg.dataBucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/"/g, '')}"`,
    }),
    { expiresIn: cfg.downloadUrlTtlSeconds },
  );
}
