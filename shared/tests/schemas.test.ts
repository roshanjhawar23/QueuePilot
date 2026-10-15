import { describe, expect, it } from 'vitest';
import { CreateJobRequestSchema, CreateUploadRequestSchema, MAX_ATTEMPTS, RetryJobRequestSchema, fileExtension } from '../src/index.js';

describe('shared API schemas', () => {
  it('accepts valid uploads and rejects unsafe names and oversize files', () => {
    expect(CreateUploadRequestSchema.safeParse({ fileName: 'sales (1).csv', sizeBytes: 10 }).success).toBe(true);
    expect(CreateUploadRequestSchema.safeParse({ fileName: '../x.csv', sizeBytes: 10 }).success).toBe(false);
    expect(CreateUploadRequestSchema.safeParse({ fileName: 'x.exe', sizeBytes: 10 }).success).toBe(false);
    expect(CreateUploadRequestSchema.safeParse({ fileName: 'x.csv', sizeBytes: 5 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(CreateUploadRequestSchema.safeParse({ fileName: 'x.csv', sizeBytes: 10, extra: 1 }).success).toBe(false);
  });

  it('only accepts input keys produced by POST /uploads and defaults failMode to none', () => {
    const ok = CreateJobRequestSchema.parse({ type: 'csv.summary', inputKey: 'inputs/11111111-1111-4111-8111-111111111111/a.csv' });
    expect(ok.failMode).toBe('none');
    expect(CreateJobRequestSchema.safeParse({ type: 'csv.summary', inputKey: 'outputs/x/a.csv' }).success).toBe(false);
    expect(CreateJobRequestSchema.safeParse({ type: 'nope', inputKey: 'inputs/11111111-1111-4111-8111-111111111111/a.csv' }).success).toBe(false);
  });

  it('validates retry bodies', () => {
    expect(RetryJobRequestSchema.safeParse({ failMode: 'none' }).success).toBe(true);
    expect(RetryJobRequestSchema.safeParse({ failMode: 'sometimes' }).success).toBe(false);
  });

  it('keeps MAX_ATTEMPTS aligned with the SQS maxReceiveCount of 3', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });

  it('extracts lower-case extensions', () => {
    expect(fileExtension('A.CSV')).toBe('.csv');
    expect(fileExtension('noext')).toBe('');
  });
});
