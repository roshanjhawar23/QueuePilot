import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorNote, Notice, PageHeader, StatusBadge, Updated } from '../components/common';
import { JobStripList } from '../components/JobStrip';
import { usePolling } from '../hooks/usePolling';
import { shortId, timeAgo } from '../lib/format';
import { useClient } from '../session';

export function Recovery() {
  const client = useClient();
  const metrics = usePolling(() => client.metrics(), 3000);
  const dead = usePolling(() => client.listJobs({ status: 'DEAD_LETTERED', limit: 25 }), 5000);
  const failed = usePolling(() => client.listJobs({ status: 'FAILED', limit: 25 }), 5000);
  const tasks = usePolling(() => client.redriveStatus(), 4000);
  const [peek, setPeek] = useState<Awaited<ReturnType<typeof client.dlqMessages>> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dlqDepth = metrics.data ? metrics.data.dlq.visible + metrics.data.dlq.inFlight : null;
  const running = tasks.data?.tasks.find((t) => t.status === 'RUNNING');

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const redrive = () =>
    act(async () => {
      const r = await client.startRedrive();
      setMessage(`Redrive started for about ${r.approximateMessages} message(s). SQS is moving them back to the main queue.`);
      await tasks.refresh();
    });

  const inspect = () =>
    act(async () => {
      setPeek(await client.dlqMessages());
    });

  return (
    <div className="page">
      <PageHeader
        title="Recovery"
        intro="Jobs that failed every attempt are parked in the SQS dead-letter queue (DLQ). Fix the cause, then retry one job or redrive them all."
        actions={<Updated at={metrics.lastUpdated} />}
      />
      <ErrorNote error={metrics.error} onRetry={metrics.refresh} />

      <section className={`dlq-panel ${dlqDepth ? 'dlq-panel-active' : ''}`} aria-labelledby="dlq-heading">
        <div>
          <h2 id="dlq-heading">Dead-letter queue</h2>
          <p className="dlq-figure" data-testid="dlq-depth">
            {dlqDepth ?? '–'}
            <span>{dlqDepth === 1 ? ' message' : ' messages'}</span>
          </p>
          <p className="muted">Messages stay here for 4 days. The CloudWatch alarm is red while this is above zero.</p>
        </div>
        <div className="dlq-actions">
          <button type="button" className="btn btn-primary" onClick={redrive} disabled={busy || !dlqDepth || Boolean(running)}>
            {running ? 'Redrive in progress…' : 'Redrive all messages'}
          </button>
          <button type="button" className="btn btn-quiet" onClick={inspect} disabled={busy}>
            Inspect messages
          </button>
        </div>
      </section>
      {message && <Notice tone="success">{message}</Notice>}
      <ErrorNote error={error} />

      {tasks.data && tasks.data.tasks.length > 0 && (
        <section aria-labelledby="tasks-heading">
          <h2 id="tasks-heading">Redrive tasks</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Moved</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.tasks.map((t, i) => (
                <tr key={t.taskHandle ?? i}>
                  <td>{t.startedAt ? timeAgo(t.startedAt) : ''}</td>
                  <td>{t.status}</td>
                  <td>
                    {t.approximateNumberOfMessagesMoved}
                    {t.approximateNumberOfMessagesToMove !== null ? ` of ${t.approximateNumberOfMessagesToMove}` : ''}
                  </td>
                  <td>{t.failureReason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {peek && (
        <section aria-labelledby="peek-heading">
          <h2 id="peek-heading">Messages in the DLQ</h2>
          <p className="muted">{peek.note}</p>
          {peek.messages.length === 0 ? (
            <p>No messages returned by this sample.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Job status now</th>
                  <th>Times received</th>
                  <th>What redrive will do</th>
                </tr>
              </thead>
              <tbody>
                {peek.messages.map((m) => (
                  <tr key={m.messageId}>
                    <td>{m.jobId ? <Link to={`/jobs/${m.jobId}`} className="text-link">{shortId(m.jobId)}</Link> : 'Unreadable message'}</td>
                    <td>{m.jobStatus && m.jobStatus !== 'MISSING' ? <StatusBadge status={m.jobStatus} /> : m.jobStatus === 'MISSING' ? 'Record deleted' : ''}</td>
                    <td>{m.receiveCount}</td>
                    <td>
                      {m.stale
                        ? 'Ignored: the job was already retried, so this copy is stale.'
                        : m.jobStatus === 'MISSING'
                          ? 'Ignored: the job record no longer exists.'
                          : 'Process the job again (a new cycle of up to 3 attempts).'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section aria-labelledby="dead-heading">
        <h2 id="dead-heading">Dead-lettered jobs</h2>
        <p className="muted">Retryable errors that never recovered. Open one to retry it, optionally with fault injection turned off.</p>
        <ErrorNote error={dead.error} />
        {dead.data?.items.length ? <JobStripList jobs={dead.data.items} /> : <p className="empty-inline">None. Every retryable failure recovered.</p>}
      </section>

      <section aria-labelledby="failed-heading">
        <h2 id="failed-heading">Failed jobs that need a fix</h2>
        <p className="muted">Bad input or parameters. These never go to the DLQ because retrying unchanged cannot work. Use Edit and retry.</p>
        <ErrorNote error={failed.error} />
        {failed.data?.items.length ? <JobStripList jobs={failed.data.items} /> : <p className="empty-inline">None.</p>}
      </section>
    </div>
  );
}
