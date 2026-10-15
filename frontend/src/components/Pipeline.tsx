import type { SystemMetricsResponse } from '@queuepilot/shared';

/**
 * The route every job travels, drawn with live numbers from SQS and DynamoDB.
 * The dead-letter queue sits below the queue as a "holding pattern".
 */
export function Pipeline({ metrics }: { metrics: SystemMetricsResponse | null }) {
  const q = metrics?.queue;
  const dlq = metrics?.dlq;
  const c = metrics?.statusCounts;
  const dlqCount = dlq ? dlq.visible + dlq.inFlight : null;
  const n = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toLocaleString());

  return (
    <figure className="pipeline" aria-label="Live job pipeline">
      <ol className="route">
        <li className="stop">
          <span className="stop-name">Upload</span>
          <span className="stop-detail">Browser to S3, max 5 MB</span>
        </li>
        <li className="stop">
          <span className="stop-name">API</span>
          <span className="stop-detail">API Gateway + Lambda</span>
        </li>
        <li className="stop stop-queue">
          <span className="stop-name">Queue</span>
          <span className="stop-figure" data-testid="queue-waiting">{n(q?.visible)}</span>
          <span className="stop-detail">
            waiting, {n(q?.inFlight)} in flight or backing off
          </span>
        </li>
        <li className="stop">
          <span className="stop-name">Worker</span>
          <span className="stop-figure">{n(c?.PROCESSING)}</span>
          <span className="stop-detail">processing now, up to 3 at once</span>
        </li>
        <li className="stop stop-done">
          <span className="stop-name">Results</span>
          <span className="stop-figure">{n(c?.SUCCEEDED)}</span>
          <span className="stop-detail">succeeded, files in S3</span>
        </li>
      </ol>
      <div className={`holding ${dlqCount ? 'holding-active' : ''}`}>
        <span className="holding-path" aria-hidden="true" />
        <div className="holding-box">
          <span className="stop-name">Dead-letter queue</span>
          <span className="stop-figure" data-testid="dlq-count">{n(dlqCount)}</span>
          <span className="stop-detail">
            {dlqCount ? 'messages parked after 3 failed attempts' : 'empty: no job has run out of attempts'}
          </span>
        </div>
      </div>
      {metrics && (
        <figcaption>
          Read live from SQS and DynamoDB in {metrics.config.region}. Queue numbers are SQS approximations and can lag by a few
          seconds.
        </figcaption>
      )}
    </figure>
  );
}
