import type { JobEvent, JobEventType } from '@queuepilot/shared';
import { clockTime } from '../lib/format';

const TONE: Partial<Record<JobEventType, string>> = {
  SUCCEEDED: 'ok',
  RESTORED: 'ok',
  ATTEMPT_FAILED: 'warn',
  RETRY_SCHEDULED: 'warn',
  FAILED: 'bad',
  DEAD_LETTERED: 'bad',
  DISPATCH_FAILED: 'bad',
  STALE_MESSAGE_DISCARDED: 'muted',
  DUPLICATE_DISCARDED: 'muted',
};

const LABEL: Record<JobEventType, string> = {
  SUBMITTED: 'Submitted',
  DISPATCH_FAILED: 'Could not queue',
  STARTED: 'Attempt started',
  ATTEMPT_FAILED: 'Attempt failed',
  RETRY_SCHEDULED: 'Retry scheduled',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  DEAD_LETTERED: 'Dead-lettered',
  REDRIVEN: 'Redriven from DLQ',
  RETRY_REQUESTED: 'Manual retry',
  DUPLICATE_DISCARDED: 'Duplicate ignored',
  STALE_MESSAGE_DISCARDED: 'Stale message ignored',
  RESTORED: 'Restored from backup',
};

/** Every recorded step of the job, oldest first, as written by the API and worker to DynamoDB. */
export function Timeline({ events }: { events: JobEvent[] }) {
  if (events.length === 0) return <p className="muted">No events recorded yet.</p>;
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className={`tl tl-${TONE[e.event] ?? 'info'}`}>
          <time dateTime={e.at}>{clockTime(e.at)}</time>
          <div>
            <strong>
              {LABEL[e.event]}
              {e.attempt ? ` (attempt ${e.attempt})` : ''}
            </strong>
            <p>{e.message}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
