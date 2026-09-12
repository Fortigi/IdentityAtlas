// Unit tests for the report download formats.
//
// The serializers are the last thing between a report and a file the user opens
// in a spreadsheet, and every failure here is silent: a missed quote shifts
// every following column, a dropped row is just a shorter file, and an
// unescaped leading `=` is a formula someone's spreadsheet executes. Nothing
// throws, so the assertions below are on exact bytes rather than on "it ran".

import { describe, it, expect } from 'vitest';
import {
  EXPORT_FORMATS, EXPORT_FORMAT_NAMES, exportFilename, resolveExportFormat,
} from './export.js';

const csv = (report) => EXPORT_FORMATS.csv.serialize(report);

const REPORT = {
  name: 'seam-sample',
  displayName: 'Seam Sample',
  columns: [{ key: 'displayName', label: 'Account' }, { key: 'email', label: 'Email' }],
  rows: [
    { displayName: 'Ada Lovelace', email: 'ada@example.com' },
    { displayName: 'Grace Hopper', email: 'grace@example.com' },
  ],
  total: 2,
  generatedAt: '2026-09-12T08:30:00.000Z',
};

describe('CSV serialization', () => {
  it('writes the column labels as the header and one line per row, CRLF-separated', () => {
    expect(csv(REPORT)).toBe(
      '"Account","Email"\r\n' +
      '"Ada Lovelace","ada@example.com"\r\n' +
      '"Grace Hopper","grace@example.com"',
    );
  });

  it('reads each cell through the column key, so column order drives the file', () => {
    // Same rows, reversed columns: the file must follow the columns, not the
    // insertion order of the row objects.
    const reversed = { ...REPORT, columns: [...REPORT.columns].reverse() };
    expect(csv(reversed).split('\r\n')[1]).toBe('"ada@example.com","Ada Lovelace"');
  });

  it('emits a header-only file when the report found nothing', () => {
    expect(csv({ ...REPORT, rows: [] })).toBe('"Account","Email"');
  });

  it('ignores row keys that are not declared columns', () => {
    const withExtras = {
      ...REPORT,
      rows: [{ displayName: 'Ada', email: 'ada@x', _entity: { kind: 'user', id: 'p1' }, secret: 'internal' }],
    };
    const line = csv(withExtras).split('\r\n')[1];
    expect(line).toBe('"Ada","ada@x"');
    expect(line).not.toMatch(/internal|_entity/);
  });

  it.each([
    ['a comma', 'Lovelace, Ada', '"Lovelace, Ada"'],
    ['a double quote', 'Ada "The Countess"', '"Ada ""The Countess"""'],
    ['a newline', 'Line one\nLine two', '"Line one\nLine two"'],
  ])('quotes %s so the field cannot break the row', (_label, value, expected) => {
    expect(csv({ ...REPORT, rows: [{ displayName: value, email: '' }] }).split('\r\n')[1])
      .toBe(`${expected},""`);
  });

  it.each([
    ['null', { displayName: 'Ada', email: null }],
    ['undefined', { displayName: 'Ada', email: undefined }],
    ['a column the row has no key for', { displayName: 'Ada' }],
  ])('writes %s as an empty field, never as the literal word', (_label, row) => {
    const line = csv({ ...REPORT, rows: [row] }).split('\r\n')[1];
    expect(line).toBe('"Ada",""');
    expect(line).not.toMatch(/null|undefined/);
  });

  it('writes a zero as a zero, not as an empty field', () => {
    const report = {
      columns: [{ key: 'count', label: 'Count' }],
      rows: [{ count: 0 }, { count: false }],
    };
    expect(csv(report)).toBe('"Count"\r\n"0"\r\n"false"');
  });

  it.each(['=cmd|calc', '+1+1', '-2+3', '@SUM(A1)', '\tlead', '\rlead'])(
    'neutralises %j so a spreadsheet treats it as text (M-05)',
    (value) => {
      const line = csv({ ...REPORT, rows: [{ displayName: value, email: '' }] }).split('\r\n')[1];
      expect(line.startsWith(`"'${value}`)).toBe(true);
    },
  );

  it('leaves an ordinary value untouched — the guard only fires on formula starters', () => {
    const line = csv({ ...REPORT, rows: [{ displayName: 'Ada = Lovelace', email: '' }] }).split('\r\n')[1];
    expect(line).toBe('"Ada = Lovelace",""');
  });

  it('tolerates a payload with neither columns nor rows', () => {
    expect(csv({})).toBe('');
  });
});

describe('JSON serialization', () => {
  it('round-trips the whole payload, metadata included', () => {
    const parsed = JSON.parse(EXPORT_FORMATS.json.serialize(REPORT));
    expect(parsed).toEqual(REPORT);
  });

  it('is indented, so a downloaded file is readable as-is', () => {
    expect(EXPORT_FORMATS.json.serialize(REPORT)).toContain('\n  "name"');
  });
});

describe('resolveExportFormat', () => {
  it('resolves every offered format to a serializer, content type and extension', () => {
    expect(EXPORT_FORMAT_NAMES.length).toBeGreaterThan(0);
    for (const name of EXPORT_FORMAT_NAMES) {
      const format = resolveExportFormat(name);
      expect(typeof format.serialize).toBe('function');
      expect(format.contentType).toMatch(/\//);
      expect(format.extension).toMatch(/^[a-z]+$/);
    }
  });

  it('returns null for a format we do not offer', () => {
    expect(resolveExportFormat('xlsx')).toBeNull();
    expect(resolveExportFormat('')).toBeNull();
  });

  it('never resolves an inherited Object.prototype member', () => {
    // The format comes straight off the query string.
    expect(resolveExportFormat('constructor')).toBeNull();
    expect(resolveExportFormat('toString')).toBeNull();
  });
});

describe('exportFilename', () => {
  it('names the file after the product, the report and the day it was computed', () => {
    expect(exportFilename('seam-sample', 'csv', '2026-09-12T08:30:00.000Z'))
      .toBe('identity-atlas-seam-sample-2026-09-12.csv');
  });

  it('uses the extension of the chosen format', () => {
    expect(exportFilename('seam-sample', 'json', '2026-09-12T08:30:00.000Z'))
      .toBe('identity-atlas-seam-sample-2026-09-12.json');
  });

  it('slugs a name that would otherwise break the quoted header', () => {
    expect(exportFilename('Odd "Name"/../etc', 'csv', '2026-09-12T00:00:00.000Z'))
      .toBe('identity-atlas-odd-name-etc-2026-09-12.csv');
  });

  it.each([
    ['no timestamp', undefined],
    ['a non-date string', 'not-a-date'],
    // Anchored: the date has to BE the start of the timestamp, not appear somewhere
    // inside it — otherwise a stray date in free text would name the file.
    ['a date buried in other text', 'stamped at 2026-09-12'],
  ])('drops the date segment given %s rather than writing a broken one', (_label, stamp) => {
    expect(exportFilename('seam-sample', 'csv', stamp)).toBe('identity-atlas-seam-sample.csv');
  });

  it('falls back to a generic stem when the name slugs away to nothing', () => {
    expect(exportFilename('***', 'csv', '2026-09-12T00:00:00.000Z'))
      .toBe('identity-atlas-report-2026-09-12.csv');
  });
});
