import type { DataValidateParams, ValidationRule } from '@queuepilot/shared';
import { fileExtension } from '@queuepilot/shared';
import { NonRetryableJobError } from '../lib/errors.js';
import { isNumeric, parseCsv } from './csv.js';
import { isMissing } from './csvSummary.js';
import { decodeText } from './text.js';
import type { ProcessorInput, ProcessorOutput } from './types.js';

const MAX_REPORTED_VIOLATIONS = 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export type Violation = {
  record: number;
  field: string;
  rule: 'required' | 'type' | 'min' | 'max' | 'allowedValues' | 'malformed';
  message: string;
  value?: unknown;
};

type RecordValue = string | number | boolean | null | undefined | object;

/** A real calendar check: 2026-02-30 is rejected even though it matches the pattern. */
export function isValidIsoDate(v: string): boolean {
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isEmpty(v: RecordValue, fromCsv: boolean): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return fromCsv ? isMissing(v) : v.trim() === '';
  return false;
}

function describe(v: RecordValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Returns the numeric value of v if it satisfies the type, otherwise a violation message.
 * CSV values are always text, so numbers/booleans are parsed; JSON values must have the native type.
 */
function checkType(v: RecordValue, type: NonNullable<ValidationRule['type']>, fromCsv: boolean): { ok: boolean; num?: number; msg?: string } {
  switch (type) {
    case 'string':
      return typeof v === 'string' ? { ok: true } : { ok: false, msg: `expected string, got ${describe(v)}` };
    case 'number':
    case 'integer': {
      let num: number | undefined;
      if (typeof v === 'number' && Number.isFinite(v)) num = v;
      else if (fromCsv && typeof v === 'string' && isNumeric(v)) num = Number(v);
      if (num === undefined) return { ok: false, msg: `expected ${type}, got ${fromCsv ? `"${String(v)}"` : describe(v)}` };
      if (type === 'integer' && !Number.isInteger(num)) return { ok: false, msg: `expected integer, got ${num}` };
      return { ok: true, num };
    }
    case 'boolean':
      if (typeof v === 'boolean') return { ok: true };
      if (fromCsv && typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return { ok: true };
      return { ok: false, msg: `expected boolean, got ${fromCsv ? `"${String(v)}"` : describe(v)}` };
    case 'date':
      return typeof v === 'string' && isValidIsoDate(v.trim())
        ? { ok: true }
        : { ok: false, msg: `expected an ISO date like 2026-01-31, got ${JSON.stringify(v)}` };
    case 'email':
      return typeof v === 'string' && EMAIL.test(v.trim()) ? { ok: true } : { ok: false, msg: `expected an email address, got ${JSON.stringify(v)}` };
  }
}

export function validateRecord(record: Record<string, RecordValue>, rules: ValidationRule[], index: number, fromCsv: boolean): Violation[] {
  const out: Violation[] = [];
  for (const rule of rules) {
    const v = record[rule.field];
    if (isEmpty(v, fromCsv)) {
      if (rule.required) out.push({ record: index, field: rule.field, rule: 'required', message: `${rule.field} is required` });
      continue;
    }
    let num: number | undefined;
    if (rule.type) {
      const t = checkType(v, rule.type, fromCsv);
      if (!t.ok) {
        out.push({ record: index, field: rule.field, rule: 'type', message: `${rule.field}: ${t.msg}`, value: v });
        continue;
      }
      num = t.num;
    } else if (typeof v === 'number') {
      num = v;
    } else if (fromCsv && typeof v === 'string' && isNumeric(v) && (rule.min !== undefined || rule.max !== undefined)) {
      num = Number(v);
    }
    if (num !== undefined) {
      if (rule.min !== undefined && num < rule.min) {
        out.push({ record: index, field: rule.field, rule: 'min', message: `${rule.field} must be >= ${rule.min} (got ${num})`, value: v });
      }
      if (rule.max !== undefined && num > rule.max) {
        out.push({ record: index, field: rule.field, rule: 'max', message: `${rule.field} must be <= ${rule.max} (got ${num})`, value: v });
      }
    }
    if (rule.allowedValues && !rule.allowedValues.includes(String(typeof v === 'string' ? v.trim() : v))) {
      out.push({
        record: index,
        field: rule.field,
        rule: 'allowedValues',
        message: `${rule.field} must be one of: ${rule.allowedValues.join(', ')}`,
        value: v,
      });
    }
  }
  return out;
}

function loadRecords(text: string, fileName: string, delimiter: string): { format: 'csv' | 'json'; records: (Record<string, RecordValue> | null)[]; structural: Violation[] } {
  const ext = fileExtension(fileName);
  if (ext === '.json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new NonRetryableJobError(`The JSON file could not be parsed: ${(e as Error).message}`, 'INVALID_JSON');
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown }).records)
        ? (parsed as { records: unknown[] }).records
        : null;
    if (!list) throw new NonRetryableJobError('JSON input must be an array of objects or an object with a "records" array.', 'INVALID_JSON_SHAPE');
    const structural: Violation[] = [];
    const records = list.map((r, i) => {
      if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, RecordValue>;
      structural.push({ record: i + 1, field: '*', rule: 'malformed', message: `record ${i + 1} is not an object`, value: r });
      return null;
    });
    return { format: 'json', records, structural };
  }
  if (ext === '.csv') {
    const rows = parseCsv(text, delimiter);
    if (rows.length === 0) throw new NonRetryableJobError('The CSV file contains no rows.', 'EMPTY_FILE');
    const headers = rows[0]!.fields.map((h) => h.trim());
    const structural: Violation[] = [];
    const records = rows.slice(1).map((row, i) => {
      if (row.error || row.fields.length !== headers.length) {
        structural.push({
          record: i + 1,
          field: '*',
          rule: 'malformed',
          message: row.error ?? `line ${row.line}: expected ${headers.length} fields but found ${row.fields.length}`,
        });
        return null;
      }
      return Object.fromEntries(headers.map((h, ci) => [h, row.fields[ci]]));
    });
    return { format: 'csv', records, structural };
  }
  throw new NonRetryableJobError(`data.validate supports .csv and .json files, not "${ext}".`, 'UNSUPPORTED_FILE_TYPE');
}

export function dataValidate({ body, fileName, params }: ProcessorInput<DataValidateParams>): ProcessorOutput {
  const text = decodeText(body);
  const { format, records, structural } = loadRecords(text, fileName, params.delimiter);
  if (records.length === 0) throw new NonRetryableJobError('The file contains no records to validate.', 'NO_RECORDS');

  const violations: Violation[] = [...structural];
  const invalidRecords = new Set(structural.map((v) => v.record));
  records.forEach((rec, i) => {
    if (!rec) return;
    const v = validateRecord(rec, params.rules, i + 1, format === 'csv');
    if (v.length) invalidRecords.add(i + 1);
    violations.push(...v);
  });
  violations.sort((a, b) => a.record - b.record);

  const byRule: Record<string, number> = {};
  const byField: Record<string, number> = {};
  for (const v of violations) {
    byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
    byField[v.field] = (byField[v.field] ?? 0) + 1;
  }

  const report = {
    jobType: 'data.validate',
    fileName,
    format,
    passed: violations.length === 0,
    recordCount: records.length,
    validRecordCount: records.length - invalidRecords.size,
    invalidRecordCount: invalidRecords.size,
    violationCount: violations.length,
    violationsByRule: byRule,
    violationsByField: byField,
    rules: params.rules,
    violations: violations.slice(0, MAX_REPORTED_VIOLATIONS),
    violationsTruncated: violations.length > MAX_REPORTED_VIOLATIONS,
    generatedAt: new Date().toISOString(),
  };

  return {
    files: [{ name: 'report.json', contentType: 'application/json', body: JSON.stringify(report, null, 2) }],
    summary: {
      passed: report.passed,
      records: report.recordCount,
      invalidRecords: report.invalidRecordCount,
      violations: report.violationCount,
    },
  };
}
