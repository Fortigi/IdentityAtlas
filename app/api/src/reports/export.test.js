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
  splitConstantColumns,
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
async function workbookOf(report) {
  const buffer = await EXPORT_FORMATS.xlsx.serialize(report);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}
/** The Data tab: the table and nothing else. */
const sheetOf = async report => (await workbookOf(report)).getWorksheet('Data');
/** The Summary tab: what the table is, and everything said about it. */
const summaryOf = async report => (await workbookOf(report)).getWorksheet('Summary');
/** Column A of a sheet, top to bottom, as text. */
const firstColumn = (sheet) => {
  const cells = [];
  sheet.eachRow(row => cells.push(String(row.getCell(1).value ?? '')));
  return cells;
};
const labelsOf = (sheet) => {
  const labels = [];
  sheet.getRow(1).eachCell(cell => labels.push(cell.value));
  return labels;
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

  it('opens with a Summary tab and then a Data tab', async () => {
    expect((await workbookOf(NOTICED)).worksheets.map(s => s.name)).toEqual(['Summary', 'Data']);
  });

  it('writes the report name and the run it came from on the Summary tab', async () => {
    const summary = await summaryOf(NOTICED);
    expect(summary.getCell('A1').value).toBe('Seam Sample');
    expect(String(summary.getCell('A2').value)).toContain('2 row(s)');
    expect(String(summary.getCell('A2').value)).toContain('2026-09-12T08:30:00.000Z');
  });

  it('puts every notice on the Summary tab, in order, and none in the table', async () => {
    const summary = firstColumn(await summaryOf(NOTICED));
    expect(summary.indexOf('2 account(s) in scope.')).toBeGreaterThan(-1);
    expect(summary.indexOf('2 account(s) in scope.'))
      .toBeLessThan(summary.indexOf('Two systems reported no activity.'));
    expect(firstColumn(await sheetOf(NOTICED))).toEqual(['Account', 'Ada Lovelace', 'Grace Hopper']);
  });

  it('starts the table on row 1 however long the summary is', async () => {
    // The discriminating case: a serializer that still wrote the summary above
    // the table would put the header lower as the notices grow.
    for (const notices of [[], NOTICED.notices]) {
      const sheet = await sheetOf({ ...NOTICED, notices, truncated: true });
      expect(sheet.getCell('A1').value).toBe('Account');
    }
  });

  it('freezes the header row and filters exactly the declared columns', async () => {
    const sheet = await sheetOf(NOTICED);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.autoFilter).toBe('A1:B1');
  });

  it('writes one row per report row, read through the column keys', async () => {
    const sheet = await sheetOf(NOTICED);
    expect(sheet.getRow(1).getCell(2).value).toBe('Email');
    expect(sheet.getRow(2).getCell(1).value).toBe('Ada Lovelace');
    expect(sheet.getRow(2).getCell(2).value).toBe('ada@example.com');
    expect(sheet.getRow(3).getCell(1).value).toBe('Grace Hopper');
    expect(sheet.lastRow.number).toBe(3);
  });

  it('follows the column order, not the key order of the row objects', async () => {
    const sheet = await sheetOf({ ...NOTICED, columns: [...REPORT.columns].reverse() });
    expect(sheet.getRow(1).getCell(1).value).toBe('Email');
    expect(sheet.getRow(2).getCell(1).value).toBe('ada@example.com');
    expect(sheet.getRow(2).getCell(2).value).toBe('Ada Lovelace');
  });

  it('leaves a formula-looking value exactly as it was, as a string cell', async () => {
    // NOT the CSV apostrophe guard. An xlsx cell is typed: a string is stored as
    // a string and Excel never evaluates it, so prefixing an apostrophe would
    // corrupt the value rather than defend it. Both halves are asserted — the
    // exact text, and that the cell is a String and not a Formula.
    const sheet = await sheetOf({ ...NOTICED, rows: [{ displayName: '=cmd|calc', email: '+1+1' }] });
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe('=cmd|calc');
    expect(row.getCell(1).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(1).formula).toBeUndefined();
    expect(row.getCell(2).value).toBe('+1+1');
  });

  it('writes a blank for a missing value and a real zero for a zero', async () => {
    const sheet = await sheetOf({
      displayName: 'Counts',
      columns: [{ key: 'thing', label: 'Thing' }, { key: 'count', label: 'Count' }],
      rows: [{ thing: 'widget', count: 0 }, { thing: 'gadget' }, { thing: 'gizmo', count: null }],
      total: 3,
    });
    expect(sheet.getRow(2).getCell(2).value).toBe(0);
    expect(sheet.getRow(3).getCell(2).value).toBeNull();
    expect(sheet.getRow(4).getCell(2).value).toBeNull();
  });

  it('says on the Summary tab when the file is not the whole answer', async () => {
    const summary = firstColumn(await summaryOf({ ...NOTICED, truncated: true }));
    expect(summary.join('\n')).toMatch(/NOT the complete result/);
    // …and it costs a row, so it cannot silently overwrite the first notice.
    expect(summary).toContain('2 account(s) in scope.');
    expect(summary.length).toBe(firstColumn(await summaryOf(NOTICED)).length + 1);
  });

  it('keeps a header-only table readable when the report found nothing', async () => {
    const sheet = await sheetOf({ ...NOTICED, rows: [], total: 0 });
    expect(labelsOf(sheet)).toEqual(['Account', 'Email']);
    expect(sheet.lastRow.number).toBe(1);
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
    expect(workbook.getWorksheet('Summary').getCell('A1').value).toBe('Report');
    expect(workbook.getWorksheet('Data').autoFilter).toBeFalsy();
  });

  it('states a run-constant column once on the Summary tab, not on every row', async () => {
    const report = {
      ...NOTICED,
      columns: [...REPORT.columns, { key: 'system', label: 'System' }],
      rows: [
        { displayName: 'Ada', email: 'ada@example.com', system: 'Ledger' },
        { displayName: 'Grace', email: 'grace@example.com', system: 'Ledger' },
      ],
      constantColumns: ['system'],
    };
    const summary = await summaryOf(report);
    expect(summary.getCell('A4').value).toBe('System');
    expect(summary.getCell('B4').value).toBe('Ledger');
    // …and gone from the table. This is the discriminating half: a serializer
    // that wrote the block but kept the column would pass every assertion above.
    const sheet = await sheetOf(report);
    expect(labelsOf(sheet)).toEqual(['Account', 'Email']);
    expect(sheet.getRow(2).getCell(3).value).toBeNull();
  });

  it('keeps a run-constant column in the table when a pivot is built on it', async () => {
    const report = {
      ...NOTICED,
      columns: [...REPORT.columns, { key: 'system', label: 'System' }, { key: 'cmdb', label: 'CMDB' }],
      rows: [{ displayName: 'Ada', email: 'ada@x', system: 'Ledger', cmdb: 'C1' }],
      constantColumns: ['system', 'cmdb'],
      pivots: [{ name: 'By system', rows: ['system'], values: [] }],
    };
    // Still stated on the Summary tab — the summary is complete either way…
    const summary = await summaryOf(report);
    expect([summary.getCell('A4').value, summary.getCell('A5').value]).toEqual(['System', 'CMDB']);
    // …but only the pivot's column stays in the table.
    const sheet = await sheetOf(report);
    expect(labelsOf(sheet)).toEqual(['Account', 'Email', 'System']);
    expect(sheet.getRow(2).getCell(3).value).toBe('Ledger');
  });

  it('keeps the block in the order the run declared, not the column order', async () => {
    const summary = await summaryOf({
      ...NOTICED,
      columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'keep', label: 'Keep' }],
      rows: [{ a: '1', b: '2', keep: 'x' }],
      constantColumns: ['b', 'a'],
    });
    expect([summary.getCell('A4').value, summary.getCell('A5').value]).toEqual(['B', 'A']);
  });

  it('gives an empty constant column its label anyway', async () => {
    // A field that exists and is unfilled is a finding; silence is not. This is
    // the common case on a source with no application catalogue.
    const summary = await summaryOf({
      ...NOTICED,
      columns: [...REPORT.columns, { key: 'cmdb', label: 'CMDB reference' }],
      rows: [{ displayName: 'Ada', email: 'ada@x', cmdb: null }],
      constantColumns: ['cmdb'],
    });
    expect(summary.getCell('A4').value).toBe('CMDB reference');
    expect(summary.getCell('B4').value).toBeNull();
  });

  it('keeps every column when the run declares none constant', async () => {
    expect(labelsOf(await sheetOf(NOTICED))).toEqual(['Account', 'Email']);
    expect((await summaryOf(NOTICED)).getCell('A4').value).not.toBe('Account');
  });

  it('returns a Buffer, so the route can send it as a binary body', async () => {
    const buffer = await EXPORT_FORMATS.xlsx.serialize(NOTICED);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // The zip magic — a .xlsx that is not a zip will not open anywhere.
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('splitConstantColumns', () => {
  const columns = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }];
  const rows = [{ a: 1, b: 2, c: 3 }, { a: 1, b: 9, c: 3 }];

  it('splits the declared keys out of the table and pairs them with their label', () => {
    expect(splitConstantColumns(columns, rows, ['a', 'c'])).toEqual({
      header: [{ key: 'a', label: 'A', value: 1 }, { key: 'c', label: 'C', value: 3 }],
      body: [{ key: 'b', label: 'B' }],
    });
  });

  it('takes the run at its word rather than checking the other rows', () => {
    // `b` is not actually constant. Keeping it would hide a bug in the report;
    // the declaration is the report's responsibility, not the serializer's.
    expect(splitConstantColumns(columns, rows, ['b']).header).toEqual([{ key: 'b', label: 'B', value: 2 }]);
  });

  it('ignores a key the report does not declare as a column', () => {
    expect(splitConstantColumns(columns, rows, ['a', 'ghost'])).toEqual({
      header: [{ key: 'a', label: 'A', value: 1 }],
      body: [{ key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
    });
  });

  it.each([
    ['nothing was declared', []],
    ['the field is absent', undefined],
    ['the field is not a list', 'a'],
  ])('changes nothing when %s', (_label, declared) => {
    expect(splitConstantColumns(columns, rows, declared)).toEqual({ header: [], body: columns });
  });

  it('changes nothing when there are no rows to read a value from', () => {
    expect(splitConstantColumns(columns, [], ['a'])).toEqual({ header: [], body: columns });
  });

  it('keeps a kept key in the table while still stating it in the header', () => {
    expect(splitConstantColumns(columns, rows, ['a', 'c'], ['c', 'ghost'])).toEqual({
      header: [{ key: 'a', label: 'A', value: 1 }, { key: 'c', label: 'C', value: 3 }],
      body: [{ key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
    });
  });

  it('refuses to empty the table — a sheet of only a header is worse', () => {
    expect(splitConstantColumns(columns, rows, ['a', 'b', 'c'])).toEqual({ header: [], body: columns });
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
      expect(typeof resolveExportFormat(name).carriesContext, name).toBe('boolean');
    }
    expect(EXPORT_FORMATS.csv.carriesContext).toBe(false);
    expect(EXPORT_FORMATS.json.carriesContext).toBe(false);
    expect(EXPORT_FORMATS.xlsx.carriesContext).toBe(true);
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
