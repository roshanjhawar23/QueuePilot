/**
 * Retry delay before the NEXT attempt, given the attempt that just failed (1-based).
 * Example with [5, 20]: attempt 1 failed -> wait 5 s; attempt 2 failed -> wait 20 s.
 * The result is clamped to SQS's visibility-timeout limits (0..43200 seconds).
 */
export function backoffDelaySeconds(failedAttempt: number, schedule: number[]): number {
  if (schedule.length === 0) return 0;
  const idx = Math.min(Math.max(failedAttempt, 1), schedule.length) - 1;
  const v = schedule[idx]!;
  return Math.min(Math.max(Math.round(v), 0), 43_200);
}

/** True when this failure used the last allowed attempt. */
export function isFinalAttempt(cycleAttempt: number, receiveCount: number, maxAttempts: number): boolean {
  return cycleAttempt >= maxAttempts || receiveCount >= maxAttempts;
}
