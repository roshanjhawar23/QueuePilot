import { describe, expect, it } from 'vitest';
import type { Job } from '@queuepilot/shared';
import { backoffDelaySeconds, isFinalAttempt } from '../../src/lib/backoff.js';
import { decideClaim, retryBlockedReason } from '../../src/lib/claim.js';
import { isAuthorized } from '../../src/handlers/authorizer.js';
import { applyFaultInjection } from '../../src/processors/faultInjection.js';
import { InjectedFaultError } from '../../src/lib/errors.js';

const now = new Date('2026-10-10T12:00:00Z');
const base = { jobId: 'j', dispatchId: 'd1', cycleAttempts: 1, status: 'QUEUED' } as Job;

describe('decideClaim (duplicate and stale protection)', () => {
  it('discards when the job is gone, stale or finished', () => {
    expect(decideClaim(null, 'd1', now)).toEqual({ action: 'discard', reason: 'not-found' });
    expect(decideClaim(base, 'old', now)).toEqual({ action: 'discard', reason: 'stale' });
    expect(decideClaim({ ...base, status: 'SUCCEEDED' }, 'd1', now)).toMatchObject({ reason: 'already-finished' });
    expect(decideClaim({ ...base, status: 'FAILED' }, 'd1', now)).toMatchObject({ reason: 'already-finished' });
  });
  it('claims queued and retry-scheduled jobs with the next attempt number', () => {
    expect(decideClaim({ ...base, status: 'RETRY_SCHEDULED', cycleAttempts: 2 }, 'd1', now)).toMatchObject({ action: 'claim', cycleAttempt: 3 });
  });
  it('defers while a lease is active and takes over after it expires', () => {
    const p = { ...base, status: 'PROCESSING' as const, leaseUntil: '2026-10-10T12:00:04.500Z' };
    expect(decideClaim(p, 'd1', now)).toEqual({ action: 'defer', delaySeconds: 6 });
    expect(decideClaim({ ...p, leaseUntil: '2026-10-10T11:59:00Z' }, 'd1', now)).toMatchObject({ action: 'claim', previousAttemptAbandoned: true, cycleAttempt: 2 });
  });
  it('starts a fresh cycle for a redriven dead-lettered job', () => {
    expect(decideClaim({ ...base, status: 'DEAD_LETTERED', cycleAttempts: 3 }, 'd1', now)).toMatchObject({ action: 'claim', cycleAttempt: 1, redriven: true });
  });
});

describe('retry rules', () => {
  it('allows FAILED, DEAD_LETTERED and stuck PROCESSING jobs only', () => {
    expect(retryBlockedReason({ ...base, status: 'FAILED' }, now)).toBeNull();
    expect(retryBlockedReason({ ...base, status: 'DEAD_LETTERED' }, now)).toBeNull();
    expect(retryBlockedReason({ ...base, status: 'PROCESSING', leaseUntil: '2026-10-10T11:00:00Z' }, now)).toBeNull();
    expect(retryBlockedReason({ ...base, status: 'PROCESSING', leaseUntil: '2026-10-10T13:00:00Z' }, now)).toMatch(/currently/);
    expect(retryBlockedReason({ ...base, status: 'SUCCEEDED' }, now)).toMatch(/already succeeded/);
    expect(retryBlockedReason({ ...base, status: 'QUEUED' }, now)).toMatch(/already queued/);
  });
});

describe('backoff', () => {
  it('follows the schedule and clamps to SQS limits', () => {
    expect(backoffDelaySeconds(1, [5, 20])).toBe(5);
    expect(backoffDelaySeconds(2, [5, 20])).toBe(20);
    expect(backoffDelaySeconds(7, [5, 20])).toBe(20);
    expect(backoffDelaySeconds(1, [99999])).toBe(43200);
    expect(backoffDelaySeconds(1, [])).toBe(0);
  });
  it('detects the final attempt from either counter', () => {
    expect(isFinalAttempt(3, 1, 3)).toBe(true);
    expect(isFinalAttempt(1, 3, 3)).toBe(true);
    expect(isFinalAttempt(2, 2, 3)).toBe(false);
  });
});

describe('authorizer', () => {
  const token = 'correct-horse-battery';
  it('accepts only the exact bearer token', () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isAuthorized(`bearer ${token}`, token)).toBe(true);
    expect(isAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(isAuthorized(token, token)).toBe(false);
    expect(isAuthorized(undefined, token)).toBe(false);
  });
  it('fails closed when the server token is missing or too short', () => {
    expect(isAuthorized('Bearer short', 'short')).toBe(false);
    expect(isAuthorized('Bearer anything-at-all', undefined)).toBe(false);
  });
});

describe('fault injection', () => {
  const ctx = { remainingMs: () => 1000, sleep: async () => {}, log: () => {} };
  it('transient fails attempts 1-2 only', async () => {
    await expect(applyFaultInjection('transient', 1, ctx)).rejects.toBeInstanceOf(InjectedFaultError);
    await expect(applyFaultInjection('transient', 2, ctx)).rejects.toThrow(/attempt 2/);
    await expect(applyFaultInjection('transient', 3, ctx)).resolves.toBeUndefined();
  });
  it('permanent always fails; none never fails', async () => {
    await expect(applyFaultInjection('permanent', 3, ctx)).rejects.toThrow(/permanent/);
    await expect(applyFaultInjection('none', 1, ctx)).resolves.toBeUndefined();
  });
  it('slow sleeps past the remaining time on attempt 1 only', async () => {
    let slept = 0;
    const c = { ...ctx, sleep: async (ms: number) => void (slept = ms) };
    await expect(applyFaultInjection('slow', 1, c)).rejects.toThrow(/time budget/);
    expect(slept).toBe(6000);
    await expect(applyFaultInjection('slow', 2, c)).resolves.toBeUndefined();
  });
});
