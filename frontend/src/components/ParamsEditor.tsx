import type { ChangeEvent } from 'react';
import type { JobParams, JobType } from '@queuepilot/shared';

/** Form state for job parameters. Kept as strings so inputs can be edited freely. */
export interface ParamsDraft {
  delimiter: string;
  topN: string;
  maxMalformedPercent: string;
  longSentenceWords: string;
  wordsPerMinute: string;
  rulesText: string;
}

export const EXAMPLE_RULES = JSON.stringify(
  [
    { field: 'customer_id', required: true, type: 'string' },
    { field: 'email', required: true, type: 'email' },
    { field: 'age', type: 'integer', min: 18, max: 120 },
    { field: 'plan', allowedValues: ['basic', 'pro', 'enterprise'] },
  ],
  null,
  2,
);

export function emptyDraft(type: JobType): ParamsDraft {
  return {
    delimiter: ',',
    topN: type === 'text.analytics' ? '10' : '5',
    maxMalformedPercent: '20',
    longSentenceWords: '30',
    wordsPerMinute: '200',
    rulesText: '',
  };
}

export function draftFromParams(type: JobType, params: JobParams): ParamsDraft {
  const p = params as Record<string, unknown>;
  const d = emptyDraft(type);
  for (const k of ['delimiter', 'topN', 'maxMalformedPercent', 'longSentenceWords', 'wordsPerMinute'] as const) {
    if (p[k] !== undefined) d[k] = String(p[k]);
  }
  if (Array.isArray(p.rules)) d.rulesText = JSON.stringify(p.rules, null, 2);
  return d;
}

/** Converts the form into the API's params object, or returns a readable error. */
export function buildParams(type: JobType, d: ParamsDraft): { params: Record<string, unknown> } | { error: string } {
  const num = (v: string) => Number(v);
  switch (type) {
    case 'csv.summary':
      return { params: { delimiter: d.delimiter, topN: num(d.topN), maxMalformedPercent: num(d.maxMalformedPercent) } };
    case 'text.analytics':
      return { params: { topN: num(d.topN), longSentenceWords: num(d.longSentenceWords), wordsPerMinute: num(d.wordsPerMinute) } };
    case 'data.validate': {
      if (!d.rulesText.trim()) return { error: 'Add at least one validation rule (or load a rules .json file).' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(d.rulesText);
      } catch {
        return { error: 'The rules are not valid JSON.' };
      }
      const rules = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown })?.rules;
      if (!Array.isArray(rules)) return { error: 'Rules must be a JSON array, or an object with a "rules" array.' };
      return { params: { rules, delimiter: d.delimiter } };
    }
  }
}

const DELIMITERS = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe (|)' },
];

export function ParamsEditor({ type, draft, onChange }: { type: JobType; draft: ParamsDraft; onChange: (d: ParamsDraft) => void }) {
  const set = (k: keyof ParamsDraft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onChange({ ...draft, [k]: e.target.value });

  const loadRulesFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onChange({ ...draft, rulesText: await file.text() });
  };

  return (
    <div className="params">
      {(type === 'csv.summary' || type === 'data.validate') && (
        <label className="field">
          <span>Delimiter</span>
          <select value={draft.delimiter} onChange={set('delimiter')}>
            {DELIMITERS.map((d) => (
              <option key={d.label} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {type === 'csv.summary' && (
        <>
          <label className="field">
            <span>Top categories per column</span>
            <input type="number" min={1} max={25} value={draft.topN} onChange={set('topN')} />
          </label>
          <label className="field">
            <span>Allowed malformed rows (%)</span>
            <input type="number" min={0} max={100} value={draft.maxMalformedPercent} onChange={set('maxMalformedPercent')} />
            <small>Above this, the job fails so you can fix the file or raise the limit.</small>
          </label>
        </>
      )}
      {type === 'text.analytics' && (
        <>
          <label className="field">
            <span>Top terms</span>
            <input type="number" min={1} max={50} value={draft.topN} onChange={set('topN')} />
          </label>
          <label className="field">
            <span>Long sentence (words)</span>
            <input type="number" min={5} max={200} value={draft.longSentenceWords} onChange={set('longSentenceWords')} />
          </label>
          <label className="field">
            <span>Reading speed (words per minute)</span>
            <input type="number" min={50} max={1000} value={draft.wordsPerMinute} onChange={set('wordsPerMinute')} />
          </label>
        </>
      )}
      {type === 'data.validate' && (
        <div className="field field-wide">
          <label htmlFor="rules">Validation rules (JSON)</label>
          <textarea id="rules" rows={10} spellCheck={false} value={draft.rulesText} onChange={set('rulesText')} placeholder={EXAMPLE_RULES} />
          <div className="row">
            <label className="btn btn-quiet file-btn">
              Load rules file
              <input type="file" accept=".json,application/json" onChange={loadRulesFile} />
            </label>
            <button type="button" className="btn btn-quiet" onClick={() => onChange({ ...draft, rulesText: EXAMPLE_RULES })}>
              Insert example rules
            </button>
          </div>
          <small>
            Each rule names a field and any of: required, type (string, number, integer, boolean, date, email), min, max, allowedValues.
          </small>
        </div>
      )}
    </div>
  );
}
