import type { CsvSummaryParams } from '@queuepilot/shared';
import { NonRetryableJobError } from '../lib/errors.js';
import { isNumeric, parseCsv, toCsv } from './csv.js';
import { decodeText, round } from './text.js';
import type { ProcessorInput, ProcessorOutput } from './types.js';

const MISSING = new Set(['', 'na', 'n/a', 'null', 'none', 'nan', '-']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_REPORTED_MALFORMED = 100;
const DELIMITER_NAMES: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

export function isMissing(v: string): boolean {
  return MISSING.has(v.trim().toLowerCase());
}

export interface NumericStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number | null;
  sum: number;
}

export function numericStats(values: number[]): NumericStats {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const stdDev = n < 2 ? null : Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  return {
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean: round(mean),
    median: round(median),
    stdDev: stdDev === null ? null : round(stdDev),
    sum: round(sum),
  };
}

export function topValues(values: string[], topN: number): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([value, count]) => ({ value, count }));
}

type ColumnReport =
  | { name: string; kind: 'numeric'; count: number; missing: number; nonNumeric: number; stats: NumericStats }
  | { name: string; kind: 'date'; count: number; missing: number; earliest: string; latest: string; distinct: number }
  | { name: string; kind: 'categorical'; count: number; missing: number; distinct: number; top: { value: string; count: number }[] }
  | { name: string; kind: 'empty'; count: 0; missing: number };

function analyzeColumn(name: string, values: string[], topN: number): ColumnReport {
  const present = values.filter((v) => !isMissing(v));
  const missing = values.length - present.length;
  if (present.length === 0) return { name, kind: 'empty', count: 0, missing };

  const numeric = present.filter(isNumeric);
  if (numeric.length / present.length >= 0.95) {
    return {
      name,
      kind: 'numeric',
      count: present.length,
      missing,
      nonNumeric: present.length - numeric.length,
      stats: numericStats(numeric.map(Number)),
    };
  }
  const dates = present.filter((v) => ISO_DATE.test(v));
  if (dates.length / present.length >= 0.95) {
    const sorted = [...dates].sort();
    return {
      name,
      kind: 'date',
      count: present.length,
      missing,
      earliest: sorted[0]!,
      latest: sorted[sorted.length - 1]!,
      distinct: new Set(dates).size,
    };
  }
  return { name, kind: 'categorical', count: present.length, missing, distinct: new Set(present).size, top: topValues(present, topN) };
}

export function csvSummary({ body, fileName, params }: ProcessorInput<CsvSummaryParams>): ProcessorOutput {
  const text = decodeText(body);
  const { delimiter, topN, maxMalformedPercent } = params;
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) throw new NonRetryableJobError('The CSV file contains no rows.', 'EMPTY_FILE');

  const headerRow = rows[0]!;
  if (headerRow.error) throw new NonRetryableJobError(`The header row is malformed: ${headerRow.error}`, 'MALFORMED_HEADER');
  const headers = headerRow.fields.map((h, i) => (h.trim() === '' ? `column_${i + 1}` : h.trim()));

  if (headers.length === 1) {
    const other = Object.keys(DELIMITER_NAMES).find((d) => d !== delimiter && headers[0]!.includes(d));
    if (other) {
      throw new NonRetryableJobError(
        `Only one column was found, but the header contains ${DELIMITER_NAMES[other]} characters. ` +
          `Retry with the delimiter parameter set to "${other === '\t' ? '\\t' : other}".`,
        'WRONG_DELIMITER',
      );
    }
  }
  const dupes = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (dupes.length > 0) {
    throw new NonRetryableJobError(`Duplicate column names in header: ${[...new Set(dupes)].join(', ')}`, 'DUPLICATE_COLUMNS');
  }

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) throw new NonRetryableJobError('The CSV file has a header but no data rows.', 'NO_DATA_ROWS');

  const valid: string[][] = [];
  const malformed: { line: number; reason: string; preview: string }[] = [];
  for (const row of dataRows) {
    const reason =
      row.error ??
      (row.fields.length !== headers.length ? `Expected ${headers.length} fields but found ${row.fields.length}` : undefined);
    if (reason) {
      malformed.push({ line: row.line, reason, preview: row.fields.join(delimiter).slice(0, 120) });
    } else {
      valid.push(row.fields.map((f) => f.trim()));
    }
  }

  const malformedPercent = round((malformed.length / dataRows.length) * 100, 2);
  if (malformedPercent > maxMalformedPercent) {
    throw new NonRetryableJobError(
      `${malformed.length} of ${dataRows.length} data rows (${malformedPercent}%) are malformed, which exceeds the ` +
        `maxMalformedPercent limit of ${maxMalformedPercent}%. First problem: line ${malformed[0]!.line}: ${malformed[0]!.reason}. ` +
        `Fix the file, or retry with a higher maxMalformedPercent to process only the valid rows.`,
      'TOO_MANY_MALFORMED_ROWS',
    );
  }

  const columns = headers.map((name, ci) =>
    analyzeColumn(
      name,
      valid.map((r) => r[ci]!),
      topN,
    ),
  );

  const result = {
    jobType: 'csv.summary',
    fileName,
    delimiter,
    rowCount: dataRows.length,
    validRowCount: valid.length,
    malformedRowCount: malformed.length,
    malformedPercent,
    columnCount: headers.length,
    columns,
    malformedRows: malformed.slice(0, MAX_REPORTED_MALFORMED),
    malformedRowsTruncated: malformed.length > MAX_REPORTED_MALFORMED,
    generatedAt: new Date().toISOString(),
  };

  return {
    files: [
      { name: 'result.json', contentType: 'application/json', body: JSON.stringify(result, null, 2) },
      { name: 'cleaned.csv', contentType: 'text/csv', body: toCsv([headers, ...valid], delimiter) },
    ],
    summary: {
      rows: dataRows.length,
      validRows: valid.length,
      malformedRows: malformed.length,
      malformedPercent,
      columns: headers.length,
      numericColumns: columns.filter((c) => c.kind === 'numeric').map((c) => c.name),
    },
  };
}
