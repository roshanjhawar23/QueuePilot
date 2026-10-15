import type { FailMode } from '@queuepilot/shared';
import { InjectedFaultError } from '../lib/errors.js';

export interface FaultContext {
  /** Milliseconds left before Lambda stops this invocation. */
  remainingMs: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * DEMO CONTROL: deliberately triggers failures inside the real worker so that the
 * retry, timeout and dead-letter behaviour of SQS + Lambda can be demonstrated live.
 * `attempt` is the attempt number within the current dispatch cycle (1-based).
 */
export async function applyFaultInjection(mode: FailMode, attempt: number, ctx: FaultContext): Promise<void> {
  switch (mode) {
    case 'none':
      return;
    case 'transient':
      if (attempt <= 2) {
        throw new InjectedFaultError(`Injected transient fault on attempt ${attempt} (this job is set to succeed on attempt 3).`);
      }
      return;
    case 'permanent':
      throw new InjectedFaultError(`Injected permanent fault on attempt ${attempt} (this job fails on every attempt).`);
    case 'slow':
      if (attempt === 1) {
        const ms = ctx.remainingMs() + 5_000;
        ctx.log('Fault injection: sleeping past the Lambda timeout', { sleepMs: ms });
        await ctx.sleep(ms);
        // On Lambda we never get here: the runtime stops the invocation at its timeout.
        throw new InjectedFaultError('Injected slow task exceeded its time budget.');
      }
      return;
  }
}
