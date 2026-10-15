/**
 * Small RFC 4180-style CSV reader/writer.
 *
 * A hand-written parser is used (instead of a library that throws on the first problem) so that
 * malformed rows can be identified individually and reported with their line numbers.
 */

export interface CsvRow {
  /** 1-based line number where the row starts in the original file. */
  line: number;
  fields: string[];
  /** Set when the row has a structural problem (e.g. an unterminated quote). */
  error?: string;
}

export function parseCsv(text: string, delimiter = ','): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let afterClosingQuote = false;
  let rowError: string | undefined;
  let line = 1;
  let rowStartLine = 1;
  let rowHasContent = false;

  const endField = () => {
    fields.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
    afterClosingQuote = false;
  };
  const endRow = () => {
    endField();
    const blank = !rowHasContent && fields.length === 1 && fields[0] === '';
    if (!blank) rows.push(rowError ? { line: rowStartLine, fields, error: rowError } : { line: rowStartLine, fields });
    fields = [];
    rowError = undefined;
    rowHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }

    if (c === delimiter) {
      rowHasContent = true;
      endField();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
      rowStartLine = line;
    } else if (c === '"') {
      rowHasContent = true;
      if (field.trim() === '' && !fieldWasQuoted) {
        inQuotes = true;
        fieldWasQuoted = true;
        field = '';
      } else {
        rowError ??= `Unexpected quote character in an unquoted field (line ${line})`;
        field += c;
      }
    } else {
      if (afterClosingQuote && c !== ' ' && c !== '\t') {
        rowError ??= `Unexpected characters after a closing quote (line ${line})`;
      }
      rowHasContent = true;
      if (!afterClosingQuote) field += c;
      else if (c !== ' ' && c !== '\t') field += c;
    }
  }

  if (inQuotes) {
    rowError ??= `Unterminated quoted field starting on line ${rowStartLine}`;
  }
  if (rowHasContent || field !== '' || fields.length > 0) endRow();
  return rows;
}

const NEEDS_QUOTES = /["\r\n]/;
const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * Escapes a value for CSV output. Also neutralises spreadsheet formula injection
 * (values starting with = + @ or a non-numeric "-") by prefixing an apostrophe.
 */
export function escapeCsvField(value: string, delimiter = ','): string {
  let v = value;
  if (/^[=+@\t\r]/.test(v) || (v.startsWith('-') && !NUMERIC.test(v))) v = `'${v}`;
  if (NEEDS_QUOTES.test(v) || v.includes(delimiter) || v !== v.trim()) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function toCsv(rows: string[][], delimiter = ','): string {
  return rows.map((r) => r.map((f) => escapeCsvField(f, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

export function isNumeric(v: string): boolean {
  return NUMERIC.test(v.trim());
}
