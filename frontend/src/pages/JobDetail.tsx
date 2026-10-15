import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FAIL_MODES, TERMINAL_STATUSES } from '@queuepilot/shared';
import type { FailMode, JobDetailResponse } from '@queuepilot/shared';
import { ErrorNote, Notice, StatusBadge, Updated } from '../components/common';
import { ParamsEditor, buildParams, draftFromParams } from '../components/ParamsEditor';
import type { ParamsDraft } from '../components/ParamsEditor';
import { Timeline } from '../components/Timeline';
import { usePolling } from '../hooks/usePolling';
import { FAIL_MODE_LABELS, STATUS_HELP, TYPE_LABELS, formatBytes, formatDuration, timeAgo } from '../lib/format';
import { useClient } from '../session';

export function canRetry(d: JobDetailResponse): boolean {
  return d.job.status === 'FAILED' || d.job.status === 'DEAD_LETTERED' || (d.job.status === 'PROCESSING' && d.leaseExpired);
}

export function JobDetail() {
  const { jobId = '' } = useParams();
  const client = useClient();
  const navigate = useNavigate();
  const [live, setLive] = useState(true);
  const detail = usePolling(
    async () => {
      const d = await client.getJob(jobId);
      setLive(!TERMINAL_STATUSES.includes(d.job.status));
      return d;
    },
    2500,
    live,
    [jobId],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ParamsDraft | null>(null);
  const [failMode, setFailMode] = useState<FailMode>('none');
  const [actionError, setActionError] = useState<Error | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const d = detail.data;

  const startEdit = () => {
    if (!d) return;
    setDraft(draftFromParams(d.job.type, d.job.params));
    setFailMode(d.job.failMode);
    setEditing(true);
    setMessage(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const retry = (withChanges: boolean) =>
    run(async () => {
      if (!d) return;
      const body: { params?: Record<string, unknown>; failMode?: FailMode } = {};
      if (withChanges && draft) {
        const built = buildParams(d.job.type, draft);
        if ('error' in built) throw new Error(built.error);
        body.params = built.params;
        body.failMode = failMode;
      }
      await client.retryJob(d.job.jobId, body);
      setEditing(false);
      setMessage(withChanges ? 'Retried with your changes. A new attempt cycle has started.' : 'Retry requested. A new attempt cycle has started.');
      setLive(true);
      await detail.refresh();
    });

  const remove = () =>
    run(async () => {
      if (!d) return;
      if (!window.confirm('Delete this job record from DynamoDB? You can bring it back from a backup that contains it.')) return;
      await client.deleteJob(d.job.jobId);
      navigate('/jobs');
    });

  if (detail.error && !d) {
    return (
      <div className="page">
        <ErrorNote error={detail.error} onRetry={detail.refresh} />
        <Link to="/jobs" className="text-link">
          Back to the job explorer
        </Link>
      </div>
    );
  }
  if (!d) return <div className="page muted">Loading job…</div>;
  const { job, events, downloads } = d;

  return (
    <div className="page">
      <header className={`detail-head strip-${job.status.toLowerCase()}`}>
        <div>
          <p className="crumb">
            <Link to="/jobs" className="text-link">
              Jobs
            </Link>{' '}
            / <code>{job.jobId}</code>
          </p>
          <h1>{job.fileName}</h1>
          <p className="muted">
            {TYPE_LABELS[job.type]}, {formatBytes(job.inputSizeBytes)}, submitted {timeAgo(job.createdAt)}
            {job.failMode !== 'none' && <> with fault injection: {FAIL_MODE_LABELS[job.failMode]}</>}
          </p>
        </div>
        <div className="detail-status">
          <StatusBadge status={job.status} />
          <Updated at={detail.lastUpdated} />
        </div>
      </header>

      <p className="status-explainer">{d.leaseExpired ? 'The worker that claimed this job stopped responding (its lease expired). You can retry it.' : STATUS_HELP[job.status]}</p>

      <div className="detail-grid">
        <section className="panel" aria-labelledby="facts">
          <h2 id="facts">Execution</h2>
          <dl className="facts">
            <dt>Attempts this cycle</dt>
            <dd>
              {job.cycleAttempts} of {job.maxAttempts}
            </dd>
            <dt>Attempts in total</dt>
            <dd>{job.totalAttempts}</dd>
            <dt>Manual retries</dt>
            <dd>{job.retryCount}</dd>
            {job.durationMs !== undefined && (
              <>
                <dt>Processing time</dt>
                <dd>{formatDuration(job.durationMs)}</dd>
              </>
            )}
            {job.nextAttemptAt && job.status === 'RETRY_SCHEDULED' && (
              <>
                <dt>Next attempt</dt>
                <dd>{new Date(job.nextAttemptAt).toLocaleTimeString()}</dd>
              </>
            )}
            {job.restoredFromBackupId && (
              <>
                <dt>Restored from backup</dt>
                <dd>
                  <code>{job.restoredFromBackupId.slice(0, 8)}</code>
                </dd>
              </>
            )}
          </dl>

          {job.lastError && job.status !== 'SUCCEEDED' && (
            <div className={`error-box ${job.lastError.retryable ? '' : 'error-box-final'}`}>
              <strong>{job.lastError.retryable ? 'Last error (retryable)' : 'Error (not retryable without a fix)'}</strong>
              <p>{job.lastError.message}</p>
              <small>Code: {job.lastError.code}</small>
            </div>
          )}

          {job.resultSummary && (
            <>
              <h3>Result summary</h3>
              <dl className="facts">
                {Object.entries(job.resultSummary).map(([k, v]) => (
                  <div key={k} className="fact-row">
                    <dt>{k}</dt>
                    <dd>{Array.isArray(v) ? v.join(', ') || 'none' : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {downloads.length > 0 && (
            <>
              <h3>Results in S3</h3>
              <ul className="downloads">
                {downloads.map((f) =>
                  f.available ? (
                    <li key={f.name}>
                      <a href={f.url} className="btn btn-quiet" download>
                        Download {f.name}
                      </a>{' '}
                      <span className="muted">{formatBytes(f.sizeBytes)}, link valid 15 minutes</span>
                    </li>
                  ) : (
                    <li key={f.name} className="muted">
                      {f.name} has expired from S3 (outputs are kept for 3 days).
                    </li>
                  ),
                )}
              </ul>
            </>
          )}

          <h3>Parameters</h3>
          <pre className="code">{JSON.stringify(job.params, null, 2)}</pre>
        </section>

        <section className="panel" aria-labelledby="history">
          <h2 id="history">Attempt history</h2>
          <Timeline events={events} />
        </section>
      </div>

      <section className="panel actions-panel" aria-labelledby="actions">
        <h2 id="actions">Actions</h2>
        {message && <Notice tone="success">{message}</Notice>}
        <ErrorNote error={actionError} />
        {canRetry(d) && !editing && (
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => retry(false)}>
              Retry
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={startEdit}>
              Edit and retry
            </button>
          </div>
        )}
        {editing && draft && (
          <div className="edit-retry">
            <p>Correct the parameters or turn off fault injection, then retry. Changes are validated by the API before the job is queued again.</p>
            <ParamsEditor type={job.type} draft={draft} onChange={setDraft} />
            <label className="field">
              <span>Fault injection (demo control)</span>
              <select value={failMode} onChange={(e) => setFailMode(e.target.value as FailMode)}>
                {FAIL_MODES.map((m) => (
                  <option key={m} value={m}>
                    {FAIL_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => retry(true)}>
                Retry with changes
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {!canRetry(d) && !TERMINAL_STATUSES.includes(job.status) && <p className="muted">Actions are available once the job stops running.</p>}
        {TERMINAL_STATUSES.includes(job.status) && (
          <div className="row">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
              Delete job record
            </button>
            <span className="muted">Used to demonstrate restore from a backup.</span>
          </div>
        )}
      </section>
    </div>
  );
}
