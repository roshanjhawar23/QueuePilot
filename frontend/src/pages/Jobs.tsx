import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { JOB_STATUSES, JobStatusSchema } from '@queuepilot/shared';
import type { JobStatus } from '@queuepilot/shared';
import { ErrorNote, Notice, PageHeader, Updated } from '../components/common';
import { JobStripList } from '../components/JobStrip';
import { usePolling } from '../hooks/usePolling';
import { STATUS_LABELS } from '../lib/format';
import { useClient } from '../session';

const PAGE_SIZE = 15;

export function Jobs() {
  const client = useClient();
  const [params, setParams] = useSearchParams();
  const parsed = JobStatusSchema.safeParse(params.get('status'));
  const status: JobStatus | undefined = parsed.success ? parsed.data : undefined;
  // Cursor stack: index 0 is the first page. DynamoDB pagination only moves forward, so we remember previous cursors.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = cursors.length - 1;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupErr, setBackupErr] = useState<Error | null>(null);

  const jobs = usePolling(() => client.listJobs({ status, limit: PAGE_SIZE, cursor: cursors[page] }), 5000, true, [status, page]);

  const setStatus = (s: JobStatus | undefined) => {
    setCursors([null]);
    setSelected(new Set());
    setParams(s ? { status: s } : {});
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const backup = async () => {
    setBackupErr(null);
    setBackupMsg(null);
    try {
      const res = await client.createBackup([...selected], `Manual backup of ${selected.size} job(s)`);
      setBackupMsg(`Backed up ${res.backup.jobCount} job(s) to S3.`);
      setSelected(new Set());
    } catch (e) {
      setBackupErr(e as Error);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Job explorer" intro="Every job recorded in DynamoDB, newest first. Select jobs to back them up." actions={<Updated at={jobs.lastUpdated} />} />

      <nav className="filter-bar" aria-label="Filter by status">
        <button type="button" className={`chip ${!status ? 'chip-on' : ''}`} onClick={() => setStatus(undefined)} aria-pressed={!status}>
          All
        </button>
        {JOB_STATUSES.map((s) => (
          <button key={s} type="button" className={`chip chip-${s.toLowerCase()} ${status === s ? 'chip-on' : ''}`} onClick={() => setStatus(s)} aria-pressed={status === s}>
            {STATUS_LABELS[s]}
          </button>
        ))}
      </nav>

      {selected.size > 0 && (
        <div className="selection-bar">
          <span>{selected.size} selected</span>
          <button type="button" className="btn btn-primary" onClick={backup}>
            Back up selected
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      {backupMsg && (
        <Notice tone="success">
          {backupMsg}{' '}
          <Link to="/backups" className="text-link">
            Open backups
          </Link>
        </Notice>
      )}
      <ErrorNote error={backupErr} />
      <ErrorNote error={jobs.error} onRetry={jobs.refresh} />

      {jobs.data && jobs.data.items.length > 0 && <JobStripList jobs={jobs.data.items} selectable selectedIds={selected} onToggle={toggle} />}
      {jobs.data && jobs.data.items.length === 0 && (
        <div className="empty">
          <p>{status ? `No jobs are ${STATUS_LABELS[status].toLowerCase()} right now.` : 'No jobs yet.'}</p>
          {!status && (
            <Link to="/submit" className="btn btn-primary">
              Submit a job
            </Link>
          )}
        </div>
      )}

      <div className="pager">
        <button type="button" className="btn btn-quiet" disabled={page === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
          Previous page
        </button>
        <span>Page {page + 1}</span>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={!jobs.data?.nextCursor}
          onClick={() => jobs.data?.nextCursor && setCursors((c) => [...c, jobs.data!.nextCursor])}
        >
          Next page
        </button>
      </div>
    </div>
  );
}
