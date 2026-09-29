// Unit tests for the report download formats.
//
// The serializers are the last thing between a report and a file the user opens
// in a spreadsheet, and every failure here is silent: a missed quote shifts
// every following column, a dropped row is just a shorter file, and an
// unescaped leading `=` is a formula someone's spreadsheet executes. Nothing
// throws, so the assertions below are on exact bytes rather than on "it ran".

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  DEFAULT_EXPORT_FORMAT, EXPORT_FORMATS, EXPORT_FORMAT_NAMES, exportFilename, resolveExportFormat,
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

// The workbook is read back with the same library that wrote it, so every
// assertion below is about what a spreadsheet will actually show — not about
// the calls the serializer happened to make.
async function sheetOf(report) {
  const buffer = await EXPORT_FORMATS.xlsx.serialize(report);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.worksheets[0];
}

/** The 1-based index of the row holding the column labels. */
const headerRowOf = (sheet, firstLabel) => {
  let found = 0;
  sheet.eachRow((row, i) => { if (!found && row.getCell(1).value === firstLabel) found = i; });
  return found;
};

describe('XLSX serialization', () => {
  const NOTICED = {
    ...REPORT,
    displayName: 'Seam Sample',
    notices: [
      { severity: 'info', text: '2 account(s) in scope.' },
      { severity: 'warning', text: 'Two systems reported no activity.' },
    ],
  };

  it('writes the report name and the run it came from above the table', async () => {
    const sheet = await sheetOf(NOTICED);
    expect(sheet.getCell('A1').value).toBe('Seam Sample');
    expect(String(sheet.getCell('A2').value)).toContain('2 row(s)');
    expect(String(sheet.getCell('A2').value)).toContain('2026-09-12T08:30:00.000Z');
  });

  it('puts every notice in the sheet, in order, above the header row', async () => {
    const sheet = await sheetOf(NOTICED);
    const header = headerRowOf(sheet, 'Account');
    const above = [];
    sheet.eachRow((row, i) => { if (i < header) above.push(String(row.getCell(1).value ?? '')); });
    expect(above).toContain('2 account(s) in scope.');
    expect(above).toContain('Two systems reported no activity.');
    expect(above.indexOf('2 account(s) in scope.'))
      .toBeLessThan(above.indexOf('Two systems reported no activity.'));
  });

  it('moves the table down as the summary grows — the header row is not a constant', async () => {
    // The discriminating case: a serializer that wrote the header at a fixed row
    // would pass every "the notices are present" assertion and then overwrite
    // them, or leave a gap. One notice must move the table by exactly one row.
    const one = await sheetOf({ ...NOTICED, notices: NOTICED.notices.slice(0, 1) });
    const two = await sheetOf(NOTICED);
    expect(headerRowOf(two, 'Account')).toBe(headerRowOf(one, 'Account') + 1);
    expect(headerRowOf(await sheetOf({ ...REPORT, notices: [] }), 'Account'))
      .toBe(headerRowOf(one, 'Account') - 1);
  });

  it('anchors the freeze and the filter on the real header row, not on row 1', async () => {
    const sheet = await sheetOf(NOTICED);
    const header = headerRowOf(sheet, 'Account');
    expect(header).toBeGreaterThan(1);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: header });
    // exceljs reads the filter back as an A1 range, which states both halves at
    // once: it starts on the header row and spans exactly the declared columns.
    expect(sheet.autoFilter).toBe(`A${header}:B${header}`);
  });

  it('writes one row per report row, read through the column keys', async () => {
    const sheet = await sheetOf(NOTICED);
    const header = headerRowOf(sheet, 'Account');
    expect(sheet.getRow(header).getCell(2).value).toBe('Email');
    expect(sheet.getRow(header + 1).getCell(1).value).toBe('Ada Lovelace');
    expect(sheet.getRow(header + 1).getCell(2).value).toBe('ada@example.com');
    expect(sheet.getRow(header + 2).getCell(1).value).toBe('Grace Hopper');
    expect(sheet.lastRow.number).toBe(header + 2);
  });

  it('follows the column order, not the key order of the row objects', async () => {
    const reversed = { ...NOTICED, columns: [...REPORT.columns].reverse() };
    const sheet = await sheetOf(reversed);
    const header = headerRowOf(sheet, 'Email');
    expect(sheet.getRow(header + 1).getCell(1).value).toBe('ada@example.com');
    expect(sheet.getRow(header + 1).getCell(2).value).toBe('Ada Lovelace');
  });

  it('leaves a formula-looking value exactly as it was, as a string cell', async () => {
    // NOT the CSV apostrophe guard. An xlsx cell is typed: a string is stored as
    // a string and Excel never evaluates it, so prefixing an apostrophe would
    // corrupt the value rather than defend it. Both halves are asserted — the
    // exact text, and that the cell is a String and not a Formula.
    const sheet = await sheetOf({ ...NOTICED, rows: [{ displayName: '=cmd|calc', email: '+1+1' }] });
    const row = sheet.getRow(headerRowOf(sheet, 'Account') + 1);
    expect(row.getCell(1).value).toBe('=cmd|calc');
    expect(row.getCell(1).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(1).formula).toBeUndefined();
    expect(row.getCell(2).value).toBe('+1+1');
  });

  it('writes a blank for a missing value and a real zero for a zero', async () => {
    const report = {
      displayName: 'Counts',
      columns: [{ key: 'thing', label: 'Thing' }, { key: 'count', label: 'Count' }],
      rows: [{ thing: 'widget', count: 0 }, { thing: 'gadget' }, { thing: 'gizmo', count: null }],
      total: 3,
    };
    const sheet = await sheetOf(report);
    const header = headerRowOf(sheet, 'Thing');
    expect(sheet.getRow(header + 1).getCell(2).value).toBe(0);
    expect(sheet.getRow(header + 2).getCell(2).value).toBeNull();
    expect(sheet.getRow(header + 3).getCell(2).value).toBeNull();
  });

  it('says in the sheet when the file is not the whole answer', async () => {
    const sheet = await sheetOf({ ...NOTICED, truncated: true });
    const header = headerRowOf(sheet, 'Account');
    const above = [];
    sheet.eachRow((row, i) => { if (i < header) above.push(String(row.getCell(1).value ?? '')); });
    expect(above.join('\n')).toMatch(/NOT the complete result/);
    // …and it costs a row, so it cannot silently overwrite the first notice.
    expect(header).toBe(headerRowOf(await sheetOf(NOTICED), 'Account') + 1);
  });

  it('keeps a header-only sheet readable when the report found nothing', async () => {
    const sheet = await sheetOf({ ...NOTICED, rows: [], total: 0 });
    const header = headerRowOf(sheet, 'Account');
    expect(sheet.getRow(header).getCell(2).value).toBe('Email');
    expect(sheet.lastRow.number).toBe(header);
  });

  it('names the sheet after the report, within what Excel accepts', async () => {
    const buffer = await EXPORT_FORMATS.xlsx.serialize({
      ...NOTICED, displayName: 'Access/Review: [2026] *everything* that is far too long to fit',
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const name = workbook.worksheets[0].name;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
    expect(name).toMatch(/^Access Review/);
  });

  it('sizes columns to their content, clamped at both ends', async () => {
    const sheet = await sheetOf({
      ...NOTICED,
      columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'Long' }],
      rows: [{ a: 'x', b: 'y'.repeat(500) }],
    });
    expect(sheet.getColumn(1).width).toBe(10);   // floor, not the 1-char label
    expect(sheet.getColumn(2).width).toBe(60);   // ceiling, not 502
  });

  it('produces a real workbook for a payload with neither columns nor rows', async () => {
    const buffer = await EXPORT_FORMATS.xlsx.serialize({});
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets[0].name).toBe('Report');
    expect(workbook.worksheets[0].autoFilter).toBeFalsy();
  });

  it('returns a Buffer, so the route can send it as a binary body', async () => {
    const buffer = await EXPORT_FORMATS.xlsx.serialize(NOTICED);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // The zip magic — a .xlsx that is not a zip will not open anywhere.
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
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

  it('names each format after its own file extension, so the two cannot drift', () => {
    for (const name of EXPORT_FORMAT_NAMES) {
      expect(resolveExportFormat(name).extension).toBe(name);
    }
  });

  it('defaults to a format it actually offers, and serves CSV as that default', () => {
    // A request with no `?format=` gets this one, so it has to resolve — and the
    // documented default is the spreadsheet one, not JSON.
    expect(EXPORT_FORMAT_NAMES).toContain(DEFAULT_EXPORT_FORMAT);
    expect(resolveExportFormat(DEFAULT_EXPORT_FORMAT).contentType).toMatch(/^text\/csv/);
  });

  it('returns null for a format we do not offer', () => {
    expect(resolveExportFormat('pdf')).toBeNull();
    expect(resolveExportFormat('')).toBeNull();
  });

  it('says of every format whether it carries the notices', () => {
    // The route reads this to decide what to hand the serializer, so it has to
    // be a real boolean on every format, not undefined on the ones that opted out.
    for (const name of EXPORT_FORMAT_NAMES) {
      expect(typeof resolveExportFormat(name).carriesNotices, name).toBe('boolean');
    }
    expect(EXPORT_FORMATS.csv.carriesNotices).toBe(false);
    expect(EXPORT_FORMATS.json.carriesNotices).toBe(false);
    expect(EXPORT_FORMATS.xlsx.carriesNotices).toBe(true);
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
