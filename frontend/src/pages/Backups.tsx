import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { RestoreBackupResponse } from '@queuepilot/shared';
import { ErrorNote, Notice, PageHeader } from '../components/common';
import { usePolling } from '../hooks/usePolling';
import { formatBytes, shortId, timeAgo } from '../lib/format';
import { useClient } from '../session';

export function Backups() {
  const client = useClient();
  const backups = usePolling(() => client.listBackups(), 15000);
  const [mode, setMode] = useState<'missing-only' | 'overwrite'>('missing-only');
  const [result, setResult] = useState<RestoreBackupResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const restore = async (backupId: string) => {
    setBusyId(backupId);
    setError(null);
    setResult(null);
    try {
      setResult(await client.restoreBackup(backupId, { mode }));
      await backups.refresh();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Backups"
        intro={
          <>
            A backup is a snapshot of selected job records and their histories, saved as JSON in S3 with a SHA-256 fingerprint. Create one
            from the <Link to="/jobs" className="text-link">job explorer</Link> by selecting jobs.
          </>
        }
      />

      <fieldset className="restore-mode">
        <legend>When restoring</legend>
        <label>
          <input type="radio" name="mode" checked={mode === 'missing-only'} onChange={() => setMode('missing-only')} /> Only bring back jobs that
          no longer exist
        </label>
        <label>
          <input type="radio" name="mode" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} /> Replace finished jobs with the
          backed-up version (active jobs are never replaced)
        </label>
      </fieldset>

      <ErrorNote error={error ?? backups.error} />
      {result && (
        <Notice tone="success">
          Restored {result.restored.length} job(s).{' '}
          {result.skipped.length > 0 && `Skipped ${result.skipped.length}: ${result.skipped.map((s) => `${shortId(s.jobId)} (${s.reason})`).join('; ')}`}
          {result.restored.map((id) => (
            <Link key={id} to={`/jobs/${id}`} className="text-link">
              Open {shortId(id)}
            </Link>
          ))}
        </Notice>
      )}

      {backups.data && backups.data.items.length === 0 && (
        <div className="empty">
          <p>No backups yet. Select one or more jobs in the job explorer and choose Back up selected.</p>
        </div>
      )}
      {backups.data && backups.data.items.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Backup</th>
              <th>Created</th>
              <th>Jobs</th>
              <th>Size</th>
              <th>Last restored</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {backups.data.items.map((b) => (
              <tr key={b.backupId}>
                <td>
                  <strong>{b.label}</strong>
                  <br />
                  <code title={`SHA-256 ${b.sha256}`}>{shortId(b.backupId)}</code>
                </td>
                <td>{timeAgo(b.createdAt)}</td>
                <td>
                  {b.jobCount} ({b.eventCount} events)
                </td>
                <td>{formatBytes(b.sizeBytes)}</td>
                <td>{b.lastRestoredAt ? timeAgo(b.lastRestoredAt) : 'Never'}</td>
                <td>
                  <button type="button" className="btn btn-quiet" disabled={busyId !== null} onClick={() => restore(b.backupId)}>
                    {busyId === b.backupId ? 'Restoring…' : 'Restore'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
