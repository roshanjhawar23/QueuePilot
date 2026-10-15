import type { ReactNode } from 'react';
import type { JobStatus } from '@queuepilot/shared';
import { STATUS_HELP, STATUS_LABELS } from '../lib/format';

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`badge badge-${status.toLowerCase()}`} title={STATUS_HELP[status]}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="note note-error" role="alert">
      <p>{error.message}</p>
      {onRetry && (
        <button type="button" className="btn btn-quiet" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'success' | 'warn'; children: ReactNode }) {
  return (
    <div className={`note note-${tone}`} role="status">
      {children}
    </div>
  );
}

export function PageHeader({ title, intro, actions }: { title: string; intro?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {intro && <p className="intro">{intro}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Updated({ at }: { at: Date | null }) {
  if (!at) return null;
  return <span className="updated">Live, updated {at.toLocaleTimeString()}</span>;
}
