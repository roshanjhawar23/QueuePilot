import { Link } from 'react-router-dom';
import type { Job } from '@queuepilot/shared';
import { FAIL_MODE_LABELS, TYPE_LABELS, shortId, timeAgo } from '../lib/format';
import { StatusBadge } from './common';

interface Props {
  job: Job;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (jobId: string) => void;
}

/** One job, drawn like an air-traffic flight strip: the coloured edge is the status. */
export function JobStrip({ job, selectable, selected, onToggle }: Props) {
  return (
    <li className={`strip strip-${job.status.toLowerCase()}`}>
      {selectable && (
        <input
          type="checkbox"
          className="strip-check"
          aria-label={`Select job ${shortId(job.jobId)}`}
          checked={Boolean(selected)}
          onChange={() => onToggle?.(job.jobId)}
        />
      )}
      <Link to={`/jobs/${job.jobId}`} className="strip-main">
        <span className="strip-id">{shortId(job.jobId)}</span>
        <span className="strip-file">{job.fileName}</span>
        <span className="strip-type">{TYPE_LABELS[job.type]}</span>
      </Link>
      <span className="strip-attempts" title="Attempts in the current cycle / maximum">
        {job.cycleAttempts}/{job.maxAttempts}
        {job.retryCount > 0 && <small> retried {job.retryCount}×</small>}
      </span>
      <span className="strip-fault">{job.failMode !== 'none' ? FAIL_MODE_LABELS[job.failMode] : ''}</span>
      <span className="strip-time" title={job.updatedAt}>
        {timeAgo(job.updatedAt)}
      </span>
      <StatusBadge status={job.status} />
    </li>
  );
}

export function JobStripList({ jobs, ...rest }: { jobs: Job[] } & Omit<Props, 'job' | 'selected'> & { selectedIds?: Set<string> }) {
  const { selectedIds, ...props } = rest;
  return (
    <ul className="strips">
      {jobs.map((j) => (
        <JobStrip key={j.jobId} job={j} {...props} selected={selectedIds?.has(j.jobId)} />
      ))}
    </ul>
  );
}
