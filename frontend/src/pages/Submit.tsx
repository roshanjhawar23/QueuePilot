import { useState } from 'react';
import type { DragEvent, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ACCEPTED_EXTENSIONS, FAIL_MODES, FAIL_MODE_DESCRIPTIONS, JOB_TYPES, MAX_UPLOAD_BYTES, fileExtension } from '@queuepilot/shared';
import type { FailMode, Job, JobType } from '@queuepilot/shared';
import { ErrorNote, Notice, PageHeader } from '../components/common';
import { ParamsEditor, buildParams, emptyDraft } from '../components/ParamsEditor';
import type { ParamsDraft } from '../components/ParamsEditor';
import { FAIL_MODE_LABELS, TYPE_LABELS, formatBytes, newIdempotencyKey, shortId } from '../lib/format';
import { useClient } from '../session';

const TYPE_HELP: Record<JobType, string> = {
  'csv.summary': 'Column statistics, missing values, top categories and a cleaned CSV.',
  'text.analytics': 'Word and sentence counts, reading time, key terms and long sentences.',
  'data.validate': 'Checks each record against your rules and reports every violation.',
};

/** Picks a sensible job type for a file; the user can change it. */
export function guessType(fileName: string, current: JobType): JobType {
  const ext = fileExtension(fileName);
  if (ACCEPTED_EXTENSIONS[current].includes(ext)) return current;
  if (ext === '.txt' || ext === '.md') return 'text.analytics';
  if (ext === '.json') return 'data.validate';
  return 'csv.summary';
}

export function validateFile(file: File | null, type: JobType): string | null {
  if (!file) return 'Choose a file to process.';
  const ext = fileExtension(file.name);
  if (!['.csv', '.txt', '.md', '.json'].includes(ext)) return 'Only .csv, .txt, .md and .json files are supported.';
  if (!ACCEPTED_EXTENSIONS[type].includes(ext)) return `${TYPE_LABELS[type]} accepts ${ACCEPTED_EXTENSIONS[type].join(', ')} files.`;
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return `The file is ${formatBytes(file.size)}. The limit is 5 MB.`;
  return null;
}

type Phase = { step: 'idle' } | { step: 'working'; message: string } | { step: 'done'; jobs: Job[] };

export function Submit() {
  const client = useClient();
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<JobType>('csv.summary');
  const [draft, setDraft] = useState<ParamsDraft>(emptyDraft('csv.summary'));
  const [failMode, setFailMode] = useState<FailMode>('none');
  const [copies, setCopies] = useState(1);
  const [error, setError] = useState<Error | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [dragging, setDragging] = useState(false);

  const chooseFile = (f: File | null) => {
    setFile(f);
    setError(null);
    setPhase({ step: 'idle' });
    if (f) {
      const t = guessType(f.name, type);
      if (t !== type) {
        setType(t);
        setDraft(emptyDraft(t));
      }
    }
  };

  const changeType = (t: JobType) => {
    setType(t);
    setDraft(emptyDraft(t));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    chooseFile(e.dataTransfer.files?.[0] ?? null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const fileError = validateFile(file, type);
    if (fileError) return setError(new Error(fileError));
    const built = buildParams(type, draft);
    if ('error' in built) return setError(new Error(built.error));
    try {
      setPhase({ step: 'working', message: 'Requesting an upload link…' });
      const upload = await client.createUpload(file!.name, file!.size);
      setPhase({ step: 'working', message: `Uploading ${file!.name} to S3…` });
      await client.uploadToS3(upload, file!);
      const jobs: Job[] = [];
      for (let i = 0; i < copies; i++) {
        setPhase({ step: 'working', message: copies > 1 ? `Submitting job ${i + 1} of ${copies}…` : 'Submitting the job…' });
        // A fresh Idempotency-Key per job: a network retry of the SAME request can never create a duplicate.
        const res = await client.createJob({ type, inputKey: upload.inputKey, params: built.params, failMode }, newIdempotencyKey());
        jobs.push(res.job);
      }
      setPhase({ step: 'done', jobs });
    } catch (err) {
      setPhase({ step: 'idle' });
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const working = phase.step === 'working';

  return (
    <div className="page">
      <PageHeader
        title="Submit a job"
        intro="Your file goes straight from the browser to S3. The API records the job in DynamoDB and puts a message on the SQS queue; a worker Lambda picks it up."
      />
      <form className="submit-form" onSubmit={submit} noValidate>
        <fieldset disabled={working}>
          <legend>File</legend>
          <label
            className={`dropzone ${dragging ? 'dropzone-active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <input type="file" accept=".csv,.txt,.md,.json" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} data-testid="file-input" />
            {file ? (
              <span>
                <strong>{file.name}</strong> {formatBytes(file.size)}
              </span>
            ) : (
              <span>Drop a .csv, .txt, .md or .json file here, or click to choose one. Maximum 5 MB.</span>
            )}
          </label>
        </fieldset>

        <fieldset disabled={working}>
          <legend>Job type</legend>
          <div className="choice-grid">
            {JOB_TYPES.map((t) => (
              <label key={t} className={`choice ${type === t ? 'choice-on' : ''}`}>
                <input type="radio" name="type" value={t} checked={type === t} onChange={() => changeType(t)} />
                <strong>{TYPE_LABELS[t]}</strong>
                <span>{TYPE_HELP[t]}</span>
                <small>Accepts {ACCEPTED_EXTENSIONS[t].join(', ')}</small>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={working}>
          <legend>Parameters</legend>
          <ParamsEditor type={type} draft={draft} onChange={setDraft} />
        </fieldset>

        <fieldset disabled={working} className="fault-panel">
          <legend>Fault injection (demo control)</legend>
          <p>
            These options make the real worker fail on purpose so retries, timeouts and the dead-letter queue can be shown live.
            Leave it on "No fault" for normal processing.
          </p>
          <div className="fault-options">
            {FAIL_MODES.map((m) => (
              <label key={m} className={`choice choice-compact ${failMode === m ? 'choice-on' : ''}`}>
                <input type="radio" name="failMode" value={m} checked={failMode === m} onChange={() => setFailMode(m)} />
                <strong>{FAIL_MODE_LABELS[m]}</strong>
                <span>{FAIL_MODE_DESCRIPTIONS[m]}</span>
              </label>
            ))}
          </div>
          <label className="field field-inline">
            <span>Copies to submit</span>
            <input type="number" min={1} max={20} value={copies} onChange={(e) => setCopies(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
            <small>Submit several identical jobs at once to watch the queue absorb a burst.</small>
          </label>
        </fieldset>

        <ErrorNote error={error} />
        {phase.step === 'working' && <Notice>{phase.message}</Notice>}
        {phase.step === 'done' && (
          <Notice tone="success">
            {phase.jobs.length === 1 ? 'Job submitted. ' : `${phase.jobs.length} jobs submitted. `}
            {phase.jobs.slice(0, 5).map((j) => (
              <Link key={j.jobId} to={`/jobs/${j.jobId}`} className="text-link">
                View {shortId(j.jobId)}
              </Link>
            ))}
          </Notice>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={working}>
            {working ? 'Working…' : copies > 1 ? `Upload and submit ${copies} jobs` : 'Upload and submit'}
          </button>
        </div>
      </form>
    </div>
  );
}
