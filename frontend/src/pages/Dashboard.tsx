import { Link } from 'react-router-dom';
import { JOB_STATUSES } from '@queuepilot/shared';
import { ErrorNote, Updated } from '../components/common';
import { JobStripList } from '../components/JobStrip';
import { Pipeline } from '../components/Pipeline';
import { usePolling } from '../hooks/usePolling';
import { STATUS_LABELS } from '../lib/format';
import { useClient } from '../session';

export function Dashboard() {
  const client = useClient();
  const metrics = usePolling(() => client.metrics(), 3000);
  const recent = usePolling(() => client.listJobs({ limit: 8 }), 4000);
  const total = metrics.data ? Object.values(metrics.data.statusCounts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-head">
          <h1>Job pipeline</h1>
          <Updated at={metrics.lastUpdated} />
        </div>
        <ErrorNote error={metrics.error} onRetry={metrics.refresh} />
        <Pipeline metrics={metrics.data} />
      </section>

      <section aria-labelledby="status-heading">
        <h2 id="status-heading">Jobs by status</h2>
        <ul className="status-tabs">
          {JOB_STATUSES.map((s) => (
            <li key={s}>
              <Link to={`/jobs?status=${s}`} className={`status-tab status-tab-${s.toLowerCase()}`}>
                <span className="status-tab-count">{metrics.data ? metrics.data.statusCounts[s] : '–'}</span>
                <span>{STATUS_LABELS[s]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="recent-heading">
        <div className="section-head">
          <h2 id="recent-heading">Recent jobs</h2>
          <Link to="/jobs" className="text-link">
            Open job explorer
          </Link>
        </div>
        <ErrorNote error={recent.error} onRetry={recent.refresh} />
        {recent.data && recent.data.items.length > 0 && <JobStripList jobs={recent.data.items} />}
        {recent.data && recent.data.items.length === 0 && total === 0 && (
          <div className="empty">
            <p>No jobs yet. Upload a CSV, text or JSON file to send the first job through the pipeline.</p>
            <Link to="/submit" className="btn btn-primary">
              Submit a job
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
