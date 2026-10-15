import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Job, JobDetailResponse, SystemMetricsResponse } from '@queuepilot/shared';
import type { QueuePilotClient } from '../src/api/client';
import { loadSession } from '../src/api/client';
import { SignIn } from '../src/App';
import { StatusBadge } from '../src/components/common';
import { Pipeline } from '../src/components/Pipeline';
import { Timeline } from '../src/components/Timeline';
import { buildParams, emptyDraft } from '../src/components/ParamsEditor';
import { usePolling } from '../src/hooks/usePolling';
import { Dashboard } from '../src/pages/Dashboard';
import { JobDetail, canRetry } from '../src/pages/JobDetail';
import { Recovery } from '../src/pages/Recovery';
import { Submit, guessType, validateFile } from '../src/pages/Submit';
import { SessionContext } from '../src/session';

const metrics = (over: Partial<SystemMetricsResponse> = {}): SystemMetricsResponse => ({
  queue: { visible: 4, inFlight: 2, delayed: 0 },
  dlq: { visible: 0, inFlight: 0, delayed: 0 },
  statusCounts: { QUEUED: 4, PROCESSING: 1, RETRY_SCHEDULED: 1, SUCCEEDED: 12, FAILED: 0, DEAD_LETTERED: 0 },
  config: { maxAttempts: 3, maxUploadBytes: 5242880, workerTimeoutSeconds: 15, region: 'us-east-1' },
  sampledAt: new Date().toISOString(),
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  jobId: '5b1c3c1e-0000-4000-8000-000000000001',
  type: 'csv.summary',
  status: 'DEAD_LETTERED',
  fileName: 'sales.csv',
  inputKey: 'inputs/x/sales.csv',
  inputSizeBytes: 4178,
  params: { delimiter: ',', topN: 5, maxMalformedPercent: 20 },
  failMode: 'permanent',
  dispatchId: 'd',
  cycleAttempts: 3,
  totalAttempts: 3,
  maxAttempts: 3,
  retryCount: 0,
  outputs: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastError: { code: 'INJECTED_FAULT', message: 'Injected permanent fault on attempt 3', retryable: true, at: new Date().toISOString() },
  ...over,
});

function withClient(client: Partial<QueuePilotClient>, ui: React.ReactNode, path = '/') {
  return render(
    <SessionContext.Provider value={{ session: { apiUrl: 'https://x', token: 't' }, client: client as QueuePilotClient, signOut: () => {} }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/jobs/:jobId" element={ui} />
          <Route path="*" element={<div>other page</div>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

describe('presentational components', () => {
  it('labels statuses in plain language with an explanation', () => {
    render(<StatusBadge status="DEAD_LETTERED" />);
    expect(screen.getByText('Dead-lettered')).toHaveAttribute('title', expect.stringMatching(/dead-letter queue/));
  });

  it('draws the live pipeline and highlights a non-empty DLQ', () => {
    const { container, rerender } = render(<Pipeline metrics={metrics()} />);
    expect(screen.getByTestId('queue-waiting')).toHaveTextContent('4');
    expect(screen.getByTestId('dlq-count')).toHaveTextContent('0');
    expect(container.querySelector('.holding-active')).toBeNull();
    rerender(<Pipeline metrics={metrics({ dlq: { visible: 2, inFlight: 0, delayed: 0 } })} />);
    expect(screen.getByTestId('dlq-count')).toHaveTextContent('2');
    expect(container.querySelector('.holding-active')).not.toBeNull();
  });

  it('shows placeholders, not invented numbers, before data arrives', () => {
    render(<Pipeline metrics={null} />);
    expect(screen.getByTestId('queue-waiting')).toHaveTextContent('–');
  });

  it('renders the attempt history', () => {
    render(
      <Timeline
        events={[
          { at: '2026-10-10T10:00:00Z', event: 'STARTED', attempt: 1, message: 'Attempt 1 of 3 started' },
          { at: '2026-10-10T10:00:01Z', event: 'RETRY_SCHEDULED', attempt: 1, message: 'Retrying in 5 s' },
        ]}
      />,
    );
    expect(screen.getByText('Attempt started (attempt 1)')).toBeInTheDocument();
    expect(screen.getByText('Retrying in 5 s')).toBeInTheDocument();
  });
});

describe('form logic', () => {
  it('validates files before uploading', () => {
    const f = (name: string, size: number) => new File([new Uint8Array(size)], name);
    expect(validateFile(null, 'csv.summary')).toMatch(/Choose a file/);
    expect(validateFile(f('a.exe', 10), 'csv.summary')).toMatch(/Only/);
    expect(validateFile(f('a.txt', 10), 'csv.summary')).toMatch(/accepts .csv/);
    expect(validateFile(f('a.csv', 0), 'csv.summary')).toMatch(/empty/);
    expect(validateFile(f('a.csv', 5 * 1024 * 1024 + 1), 'csv.summary')).toMatch(/limit is 5 MB/);
    expect(validateFile(f('a.csv', 10), 'csv.summary')).toBeNull();
  });

  it('guesses the job type from the file extension', () => {
    expect(guessType('notes.md', 'csv.summary')).toBe('text.analytics');
    expect(guessType('orders.json', 'csv.summary')).toBe('data.validate');
    expect(guessType('x.csv', 'data.validate')).toBe('data.validate');
  });

  it('builds parameters and rejects bad validation rules', () => {
    expect(buildParams('csv.summary', emptyDraft('csv.summary'))).toEqual({ params: { delimiter: ',', topN: 5, maxMalformedPercent: 20 } });
    const d = emptyDraft('data.validate');
    expect(buildParams('data.validate', d)).toEqual({ error: expect.stringMatching(/at least one/) });
    expect(buildParams('data.validate', { ...d, rulesText: '{bad' })).toEqual({ error: 'The rules are not valid JSON.' });
    expect(buildParams('data.validate', { ...d, rulesText: '{"rules":[{"field":"a"}]}' })).toEqual({ params: { rules: [{ field: 'a' }], delimiter: ',' } });
  });

  it('blocks oversized files in the submit form without calling the API', async () => {
    const createUpload = vi.fn();
    withClient({ createUpload }, <Submit />);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 10)], 'big.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByTestId('file-input'), big);
    await userEvent.click(screen.getByRole('button', { name: 'Upload and submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/limit is 5 MB/);
    expect(createUpload).not.toHaveBeenCalled();
  });

  it('uploads then submits with fault injection and shows the job link', async () => {
    const createUpload = vi.fn(async () => ({ uploadId: 'u', inputKey: 'inputs/u/a.csv', url: 'https://s3', fields: {}, maxBytes: 1, expiresInSeconds: 300 }));
    const uploadToS3 = vi.fn(async () => {});
    const createJob = vi.fn(async () => ({ job: job({ status: 'QUEUED' }), idempotentReplay: false }));
    withClient({ createUpload, uploadToS3, createJob }, <Submit />);
    await userEvent.upload(screen.getByTestId('file-input'), new File(['a,b\n1,2\n'], 'a.csv', { type: 'text/csv' }));
    await userEvent.click(screen.getByRole('radio', { name: /Transient fault/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Upload and submit' }));
    await screen.findByText(/Job submitted/);
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ type: 'csv.summary', inputKey: 'inputs/u/a.csv', failMode: 'transient' }), expect.any(String));
    expect(screen.getByRole('link', { name: /View 5b1c3c1e/ })).toBeInTheDocument();
  });
});

describe('pages wired to the API', () => {
  it('dashboard shows an empty state when the API reports no jobs', async () => {
    const empty = metrics({ queue: { visible: 0, inFlight: 0, delayed: 0 }, statusCounts: { QUEUED: 0, PROCESSING: 0, RETRY_SCHEDULED: 0, SUCCEEDED: 0, FAILED: 0, DEAD_LETTERED: 0 } });
    withClient({ metrics: async () => empty, listJobs: async () => ({ items: [], nextCursor: null }) }, <Dashboard />);
    expect(await screen.findByText(/No jobs yet/)).toBeInTheDocument();
  });

  it('job detail offers Retry for a dead-lettered job and sends corrected settings', async () => {
    const detail: JobDetailResponse = { job: job(), events: [], downloads: [], leaseExpired: false };
    const retryJob = vi.fn(async () => ({ job: job({ status: 'QUEUED' }) }));
    withClient({ getJob: async () => detail, retryJob }, <JobDetail />, `/jobs/${detail.job.jobId}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit and retry' }));
    await userEvent.selectOptions(screen.getByLabelText('Fault injection (demo control)'), 'none');
    await userEvent.click(screen.getByRole('button', { name: 'Retry with changes' }));
    await waitFor(() => expect(retryJob).toHaveBeenCalledWith(detail.job.jobId, { params: { delimiter: ',', topN: 5, maxMalformedPercent: 20 }, failMode: 'none' }));
  });

  it('only allows retry for failed, dead-lettered or stuck jobs', () => {
    const d = (o: Partial<Job>, leaseExpired = false): JobDetailResponse => ({ job: job(o), events: [], downloads: [], leaseExpired });
    expect(canRetry(d({ status: 'FAILED' }))).toBe(true);
    expect(canRetry(d({ status: 'SUCCEEDED' }))).toBe(false);
    expect(canRetry(d({ status: 'PROCESSING' }))).toBe(false);
    expect(canRetry(d({ status: 'PROCESSING' }, true))).toBe(true);
  });

  it('recovery disables redrive when the DLQ is empty and enables it when not', async () => {
    let m = metrics();
    const client = {
      metrics: async () => m,
      listJobs: async () => ({ items: [], nextCursor: null }),
      redriveStatus: async () => ({ tasks: [] }),
      startRedrive: vi.fn(async () => ({ taskHandle: 't', approximateMessages: 2 })),
    };
    const view = withClient(client, <Recovery />);
    const button = await screen.findByRole('button', { name: 'Redrive all messages' });
    await waitFor(() => expect(screen.getByTestId('dlq-depth')).toHaveTextContent('0'));
    expect(button).toBeDisabled();
    view.unmount();
    m = metrics({ dlq: { visible: 2, inFlight: 0, delayed: 0 } });
    withClient(client, <Recovery />);
    await waitFor(() => expect(screen.getByTestId('dlq-depth')).toHaveTextContent('2'));
    await userEvent.click(screen.getByRole('button', { name: 'Redrive all messages' }));
    expect(client.startRedrive).toHaveBeenCalled();
    expect(await screen.findByText(/Redrive started/)).toBeInTheDocument();
  });
});

describe('sign in', () => {
  it('verifies the token against the API before continuing', async () => {
    const onSignedIn = vi.fn();
    const f = vi.fn(async () => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }));
    render(<SignIn onSignedIn={onSignedIn} fetchImpl={f} />);
    await userEvent.type(screen.getByLabelText('API URL'), 'https://abc.execute-api.us-east-1.amazonaws.com/');
    await userEvent.type(screen.getByLabelText(/^Demo token/), 'wrong-token-123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/token was rejected/);
    expect(onSignedIn).not.toHaveBeenCalled();

    f.mockImplementation(async () => new Response(JSON.stringify(metrics()), { status: 200 }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ apiUrl: 'https://abc.execute-api.us-east-1.amazonaws.com', token: 'wrong-token-123456' }));
    expect(loadSession()?.apiUrl).toBe('https://abc.execute-api.us-east-1.amazonaws.com');
  });
});

describe('usePolling', () => {
  function Probe({ load }: { load: () => Promise<number> }) {
    const { data } = usePolling(load, 1000);
    return <span data-testid="v">{data ?? 'none'}</span>;
  }

  it('polls on an interval and pauses while the tab is hidden', async () => {
    vi.useFakeTimers();
    let n = 0;
    const load = vi.fn(async () => ++n);
    render(<Probe load={load} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(load).toHaveBeenCalledTimes(3);

    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(load).toHaveBeenCalledTimes(3);
    vis.mockRestore();
    vi.useRealTimers();
  });
});
