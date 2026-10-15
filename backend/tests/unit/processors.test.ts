import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJobParams } from '@queuepilot/shared';
import type { CsvSummaryParams, DataValidateParams, TextAnalyticsParams } from '@queuepilot/shared';
import { parseCsv, escapeCsvField, toCsv } from '../../src/processors/csv.js';
import { csvSummary, numericStats } from '../../src/processors/csvSummary.js';
import { textAnalytics, stripMarkdown, splitSentences } from '../../src/processors/textAnalytics.js';
import { dataValidate, isValidIsoDate } from '../../src/processors/dataValidate.js';
import { NonRetryableJobError } from '../../src/lib/errors.js';
import { decodeText } from '../../src/processors/text.js';

const sampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sample-data');
const sample = (name: string) => new Uint8Array(readFileSync(path.join(sampleDir, name)));
const enc = (s: string) => new TextEncoder().encode(s);
const csvParams = (p: unknown = {}) => parseJobParams('csv.summary', p) as CsvSummaryParams;
const textParams = (p: unknown = {}) => parseJobParams('text.analytics', p) as TextAnalyticsParams;
const validateParams = (p: unknown) => parseJobParams('data.validate', p) as DataValidateParams;
const json = (body: string) => JSON.parse(body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('CSV parser', () => {
  it('handles quotes, escaped quotes, embedded delimiters/newlines and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n1,2,3\r\n');
    expect(rows.map((r) => r.fields)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
    expect(rows[2]!.line).toBe(4); // quoted newline advanced the line counter
  });

  it('skips blank lines and flags unterminated quotes', () => {
    const rows = parseCsv('a,b\n\n1,2\n"open,3\n');
    expect(rows).toHaveLength(3);
    expect(rows[2]!.error).toMatch(/Unterminated/);
  });

  it('supports other delimiters', () => {
    expect(parseCsv('a;b\n1;2', ';')[1]!.fields).toEqual(['1', '2']);
  });

  it('escapes output and neutralises spreadsheet formulas', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "x"')).toBe('"say ""x"""');
    expect(escapeCsvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(escapeCsvField('-5')).toBe('-5');
    expect(escapeCsvField('-cmd')).toBe("'-cmd");
    expect(toCsv([['a', 'b'], ['1', '2']])).toBe('a,b\r\n1,2\r\n');
  });
});

describe('decodeText', () => {
  it('rejects empty, binary and invalid UTF-8 as non-retryable', () => {
    expect(() => decodeText(new Uint8Array())).toThrow(NonRetryableJobError);
    expect(() => decodeText(new Uint8Array([0x50, 0x4b, 0x00, 0x01]))).toThrow(/binary/);
    expect(() => decodeText(new Uint8Array([0xc3, 0x28]))).toThrow(/UTF-8/);
  });
  it('strips a UTF-8 BOM', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
  });
});

describe('csv.summary', () => {
  it('computes exact statistics for sample-data/sales.csv and flags malformed rows', () => {
    const out = csvSummary({ body: sample('sales.csv'), fileName: 'sales.csv', params: csvParams() });
    const result = json(out.files[0]!.body);
    expect(result.rowCount).toBe(63);
    expect(result.validRowCount).toBe(60);
    expect(result.malformedRowCount).toBe(3);
    expect(result.malformedRows.map((r: { line: number }) => r.line)).toEqual([16, 34, 49]);

    const units = result.columns.find((c: { name: string }) => c.name === 'units');
    expect(units.kind).toBe('numeric');
    // Expected values computed independently with Python's statistics module.
    expect(units.stats).toEqual({ min: 1, max: 39, mean: 18.7667, median: 18, stdDev: 11.2074, sum: 1126 });

    const discount = result.columns.find((c: { name: string }) => c.name === 'discount_pct');
    expect(discount.missing).toBe(8);

    const region = result.columns.find((c: { name: string }) => c.name === 'region');
    expect(region.kind).toBe('categorical');
    expect(region.top[0]).toEqual({ value: 'East', count: 17 });

    const date = result.columns.find((c: { name: string }) => c.name === 'order_date');
    expect(date.kind).toBe('date');

    const cleaned = parseCsv(out.files[1]!.body);
    expect(out.files[1]!.name).toBe('cleaned.csv');
    expect(cleaned).toHaveLength(61); // header + 60 valid rows
    expect(cleaned[1]!.fields[8]).toBe('Repeat customer');
    expect(out.summary).toMatchObject({ rows: 63, validRows: 60, malformedRows: 3 });
  });

  it('fails NON-retryably when too many rows are malformed, and succeeds with a corrected threshold', () => {
    const body = sample('malformed.csv');
    expect(() => csvSummary({ body, fileName: 'malformed.csv', params: csvParams() })).toThrow(/\(30%\) are malformed, which exceeds the maxMalformedPercent limit of 20%/);
    try {
      csvSummary({ body, fileName: 'malformed.csv', params: csvParams() });
    } catch (e) {
      expect(e).toBeInstanceOf(NonRetryableJobError);
      expect((e as NonRetryableJobError).code).toBe('TOO_MANY_MALFORMED_ROWS');
    }
    const ok = csvSummary({ body, fileName: 'malformed.csv', params: csvParams({ maxMalformedPercent: 50 }) });
    expect(json(ok.files[0]!.body).validRowCount).toBe(14);
  });

  it('suggests the right delimiter when only one column is found', () => {
    expect(() => csvSummary({ body: enc('a;b;c\n1;2;3\n'), fileName: 'x.csv', params: csvParams() })).toThrow(/delimiter parameter set to ";"/);
    const ok = csvSummary({ body: enc('a;b;c\n1;2;3\n'), fileName: 'x.csv', params: csvParams({ delimiter: ';' }) });
    expect(ok.summary.columns).toBe(3);
  });

  it('rejects duplicate headers, header-only files and empty files', () => {
    expect(() => csvSummary({ body: enc('a,a\n1,2\n'), fileName: 'x.csv', params: csvParams() })).toThrow(/Duplicate column/);
    expect(() => csvSummary({ body: enc('a,b\n'), fileName: 'x.csv', params: csvParams() })).toThrow(/no data rows/);
    expect(() => csvSummary({ body: enc('\n\n'), fileName: 'x.csv', params: csvParams() })).toThrow(/no rows/);
  });

  it('numericStats handles single values (no std dev) and even-length medians', () => {
    expect(numericStats([5])).toMatchObject({ min: 5, max: 5, median: 5, stdDev: null });
    expect(numericStats([1, 2, 3, 4]).median).toBe(2.5);
  });
});

describe('text.analytics', () => {
  it('analyzes sample-data/article.txt', () => {
    const out = textAnalytics({ body: sample('article.txt'), fileName: 'article.txt', params: textParams() });
    const r = json(out.files[0]!.body);
    const words = readFileSync(path.join(sampleDir, 'article.txt'), 'utf8').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)!;
    expect(r.wordCount).toBe(words.length);
    expect(r.paragraphCount).toBe(4);
    expect(r.sentenceCount).toBe(15); // counted by hand
    expect(r.readingTime.minutes).toBe(Math.ceil(words.length / 200));
    const terms = r.topTerms.map((t: { term: string }) => t.term);
    expect(terms).toContain('queues');
    expect(terms).not.toContain('the');
    expect(r.longSentences.every((s: { words: number }) => s.words > 30)).toBe(true);
  });

  it('strips Markdown syntax and code blocks before counting', () => {
    const out = textAnalytics({ body: sample('release-notes.md'), fileName: 'release-notes.md', params: textParams() });
    const r = json(out.files[0]!.body);
    expect(r.format).toBe('markdown');
    const terms = r.topTerms.map((t: { term: string }) => t.term);
    expect(terms).not.toContain('npm'); // only appears inside a fenced code block
    expect(terms).not.toContain('https');
    expect(stripMarkdown('## Title\n**bold** [link](http://x.y)')).toBe('Title\nbold link');
  });

  it('splits sentences without breaking on decimals', () => {
    expect(splitSentences('Version 2.5 is out. It is great! Really?')).toEqual(['Version 2.5 is out.', 'It is great!', 'Really?']);
  });

  it('fails non-retryably for files with no words', () => {
    expect(() => textAnalytics({ body: enc('... !!! ???'), fileName: 'x.txt', params: textParams() })).toThrow(NonRetryableJobError);
  });
});

describe('data.validate', () => {
  const customersRules = JSON.parse(readFileSync(path.join(sampleDir, 'customers.rules.json'), 'utf8'));
  const ordersRules = JSON.parse(readFileSync(path.join(sampleDir, 'orders.rules.json'), 'utf8'));

  it('reports every violation in sample-data/customers.csv', () => {
    const out = dataValidate({ body: sample('customers.csv'), fileName: 'customers.csv', params: validateParams(customersRules) });
    const r = json(out.files[0]!.body);
    expect(r.recordCount).toBe(8);
    expect(r.passed).toBe(false);
    const found = r.violations.map((v: { record: number; field: string; rule: string }) => `${v.record}:${v.field}:${v.rule}`);
    expect(found).toEqual([
      '2:email:type',
      '2:signup_date:type', // 2026-02-30 is not a real date
      '3:name:required',
      '4:age:min',
      '5:age:type',
      '5:plan:allowedValues',
      '6:monthly_spend:min',
      '8:customer_id:required',
    ]);
    expect(r.validRecordCount).toBe(2);
    expect(r.invalidRecordCount).toBe(6);
  });

  it('applies strict native types for JSON input', () => {
    const out = dataValidate({ body: sample('orders.json'), fileName: 'orders.json', params: validateParams(ordersRules) });
    const r = json(out.files[0]!.body);
    const found = r.violations.map((v: { record: number; field: string; rule: string }) => `${v.record}:${v.field}:${v.rule}`);
    expect(found).toEqual([
      '2:total:type', // "80" is a string in JSON
      '2:paid:type',
      '3:customer:required',
      '3:total:min',
      '3:placedAt:type',
      '4:total:max',
      '4:currency:allowedValues',
    ]);
    expect(r.validRecordCount).toBe(2);
  });

  it('passes when all records are valid and reports malformed CSV rows', () => {
    const rules = validateParams({ rules: [{ field: 'a', type: 'integer', required: true }] });
    expect(json(dataValidate({ body: enc('a\n1\n2\n'), fileName: 'x.csv', params: rules }).files[0]!.body).passed).toBe(true);
    const r = json(dataValidate({ body: enc('a,b\n1,2\n3\n'), fileName: 'x.csv', params: rules }).files[0]!.body);
    expect(r.violations[0]).toMatchObject({ record: 2, rule: 'malformed' });
  });

  it('rejects unparseable JSON and wrong shapes non-retryably', () => {
    const rules = validateParams({ rules: [{ field: 'a' }] });
    expect(() => dataValidate({ body: enc('{bad'), fileName: 'x.json', params: rules })).toThrow(/could not be parsed/);
    expect(() => dataValidate({ body: enc('{"a":1}'), fileName: 'x.json', params: rules })).toThrow(/array of objects/);
    expect(json(dataValidate({ body: enc('{"records":[{"a":1}]}'), fileName: 'x.json', params: rules }).files[0]!.body).passed).toBe(true);
  });

  it('checks real calendar dates', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-09-01T10:00:00Z')).toBe(true);
  });
});

describe('parameter schemas', () => {
  it('applies defaults and rejects unknown or invalid parameters', () => {
    expect(csvParams()).toEqual({ delimiter: ',', topN: 5, maxMalformedPercent: 20 });
    expect(() => csvParams({ bogus: 1 })).toThrow();
    expect(() => validateParams({ rules: [] })).toThrow();
    expect(() => validateParams({ rules: [{ field: 'x', min: 5, max: 1 }] })).toThrow();
  });
});
