import { NonRetryableJobError } from '../lib/errors.js';

/**
 * Decodes an uploaded file as UTF-8 text.
 * Binary files and invalid UTF-8 are rejected as NON-retryable errors: retrying cannot fix them.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new NonRetryableJobError('The file is empty.', 'EMPTY_FILE');
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (probe.includes(0)) {
    throw new NonRetryableJobError('The file appears to be binary, not text.', 'BINARY_FILE');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new NonRetryableJobError('The file is not valid UTF-8 text. Save it as UTF-8 and upload it again.', 'INVALID_ENCODING');
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
