import type { Job } from '@queuepilot/shared';

/**
 * Decides what the worker should do with an SQS message, given the job record's current state.
 *
 * SQS guarantees "at-least-once" delivery, so the worker must tolerate:
 *  - duplicates of a message that already finished          -> discard
 *  - old messages from a dispatch that was replaced by retry -> discard (stale, fenced by dispatchId)
 *  - a duplicate arriving while another worker is still busy -> defer until that worker's lease ends
 *  - a message redelivered after a timeout/crash             -> take over (lease has expired)
 *  - a message redriven from the DLQ                         -> start a fresh attempt cycle
 */
export type ClaimDecision =
  | { action: 'claim'; cycleAttempt: number; redriven: boolean; previousAttemptAbandoned: boolean }
  | { action: 'discard'; reason: 'not-found' | 'stale' | 'already-finished' }
  | { action: 'defer'; delaySeconds: number };

export function decideClaim(job: Job | null, dispatchId: string, now: Date): ClaimDecision {
  if (!job) return { action: 'discard', reason: 'not-found' };
  if (job.dispatchId !== dispatchId) return { action: 'discard', reason: 'stale' };

  switch (job.status) {
    case 'SUCCEEDED':
    case 'FAILED':
      return { action: 'discard', reason: 'already-finished' };
    case 'DEAD_LETTERED':
      // Only reachable when the DLQ message was redriven to the main queue.
      return { action: 'claim', cycleAttempt: 1, redriven: true, previousAttemptAbandoned: false };
    case 'PROCESSING': {
      const leaseEnd = job.leaseUntil ? Date.parse(job.leaseUntil) : 0;
      if (leaseEnd > now.getTime()) {
        return { action: 'defer', delaySeconds: Math.ceil((leaseEnd - now.getTime()) / 1000) + 1 };
      }
      return { action: 'claim', cycleAttempt: job.cycleAttempts + 1, redriven: false, previousAttemptAbandoned: true };
    }
    case 'QUEUED':
    case 'RETRY_SCHEDULED':
      return { action: 'claim', cycleAttempt: job.cycleAttempts + 1, redriven: false, previousAttemptAbandoned: false };
  }
}

/** Retry rules for POST /jobs/{id}/retry. Returns null if allowed, otherwise the reason it is not. */
export function retryBlockedReason(job: Job, now: Date): string | null {
  if (job.status === 'FAILED' || job.status === 'DEAD_LETTERED') return null;
  if (job.status === 'PROCESSING') {
    const leaseEnd = job.leaseUntil ? Date.parse(job.leaseUntil) : 0;
    return leaseEnd > now.getTime() ? 'The job is currently being processed.' : null; // stuck job: lease expired
  }
  if (job.status === 'SUCCEEDED') return 'The job already succeeded. Submit a new job to process the file again.';
  return 'The job is already queued for processing.';
}
