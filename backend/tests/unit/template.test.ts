/** Guards against configuration drift between the SAM template and the code. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS } from '@queuepilot/shared';

const template = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../template.yaml'), 'utf8');
const num = (re: RegExp) => Number(re.exec(template)?.[1]);

describe('template.yaml consistency', () => {
  it('SQS maxReceiveCount equals MAX_ATTEMPTS everywhere', () => {
    expect(num(/maxReceiveCount: (\d+)/)).toBe(MAX_ATTEMPTS);
    const envValues = [...template.matchAll(/MAX_ATTEMPTS: '(\d+)'/g)].map((m) => Number(m[1]));
    expect(envValues.length).toBeGreaterThanOrEqual(2);
    expect(envValues.every((v) => v === MAX_ATTEMPTS)).toBe(true);
  });

  it('queue visibility timeout is at least 6x the worker timeout', () => {
    const visibility = num(/VisibilityTimeout: (\d+)/);
    const workerBlock = template.slice(template.indexOf('  WorkerFunction:'));
    const workerTimeout = Number(/Timeout: (\d+)/.exec(workerBlock)?.[1]);
    expect(workerTimeout).toBe(15);
    expect(visibility).toBeGreaterThanOrEqual(6 * workerTimeout);
    expect(template).toContain("WORKER_TIMEOUT_SECONDS: '15'");
  });

  it('every log group has a retention period', () => {
    const groups = template.match(/Type: AWS::Logs::LogGroup/g) ?? [];
    const retention = template.match(/RetentionInDays: 7/g) ?? [];
    expect(groups.length).toBe(4);
    expect(retention.length).toBe(groups.length);
  });

  it('caps worker concurrency and throttles the API', () => {
    expect(template).toMatch(/MaximumConcurrency: 3/);
    expect(template).toMatch(/ThrottlingRateLimit: 10/);
    expect(template).toMatch(/NoEcho: true/);
  });
});
