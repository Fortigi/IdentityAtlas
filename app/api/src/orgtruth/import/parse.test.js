import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  parseList, ListParseError, MAX_ROWS, findHeaderIndex, detectFormat, cellToString, sniffDelimiter, parseCsv, headerNames, looksLikeData,
} from './parse.js';

const csv = (text) => Buffer.from(text, 'utf8');

async function xlsxOf(build) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function refusal(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected a refusal');
}

describe('parseList — csv', () => {
  it('reads semicolon lists with a BOM, keeping values as strings keyed by header', async () => {
    const out = await parseList(csv('﻿Code;Name;Owner\r\nP-1;Atlas;Ann de Vries\r\nP-2;Beacon;Bob\r\n'), { fileName: 'p.csv' });
    expect(out.columns).toEqual(['Code', 'Name', 'Owner']);
    expect(out.rows).toEqual([
      { Code: 'P-1', Name: 'Atlas', Owner: 'Ann de Vries' },
      { Code: 'P-2', Name: 'Beacon', Owner: 'Bob' },
    ]);
  });

  it('honours RFC 4180 quotes: delimiters, line breaks and doubled quotes inside a value', async () => {
    const out = await parseList(csv('a,b\n"x, y","line1\nline2"\n"say ""hi""",z'));
    expect(out.rows).toEqual([
      { a: 'x, y', b: 'line1\nline2' },
      { a: 'say "hi"', b: 'z' },
    ]);
  });

  it('drops trailing empty rows but keeps empty rows in between (row numbers match the file)', async () => {
    const out = await parseList(csv('a,b\n1,2\n,\n3,4\n\n,\n  ,\n'));
    expect(out.rows).toEqual([{ a: '1', b: '2' }, { a: '', b: '' }, { a: '3', b: '4' }]);
  });

  it('skips blank lines above the header, pads short rows and ignores cells past the header', async () => {
    const out = await parseList(csv('\n\nx,y\n1\n1,2,3'));
    expect(out.columns).toEqual(['x', 'y']);
    expect(out.rows).toEqual([{ x: '1', y: '' }, { x: '1', y: '2' }]);
  });

  it('renames empty and repeated headers to their position', async () => {
    const out = await parseList(csv('Name,,Name,Owner\n1,2,3,4'));
    expect(out.columns).toEqual(['Name', 'Column 2', 'Column 3', 'Owner']);
    expect(out.rows[0]).toEqual({ Name: '1', 'Column 2': '2', 'Column 3': '3', Owner: '4' });
  });

  it('refuses an empty file, a file of blank lines, and an unterminated quote with a sentence', async () => {
    expect((await refusal(parseList(Buffer.alloc(0)))).message).toBe('The file is empty.');
    expect(await refusal(parseList(undefined))).toBeInstanceOf(ListParseError);
    expect((await refusal(parseList(csv('\n , \n')))).message).toMatch(/no header row/);
    const open = await refusal(parseList(csv('a\n"never closed')));
    expect(open).toBeInstanceOf(ListParseError);
    expect(open.message).toMatch(/closing quote/);
  });

  it('accepts exactly MAX_ROWS data rows (plus trailing blank lines) and refuses one more', async () => {
    const atCap = await parseList(csv('a\n' + 'x\n'.repeat(MAX_ROWS) + '\n\n'));
    expect(atCap.rows).toHaveLength(MAX_ROWS);
    const over = await refusal(parseList(csv('a\n' + 'x\n'.repeat(MAX_ROWS + 1))));
    expect(over.message).toMatch(/more than 200,000 data rows/);
  });

  it('stops reading early when a csv is far past the cap', async () => {
    const err = await refusal(parseList(csv('a\n' + 'x\n'.repeat(MAX_ROWS + 2000))));
    expect(err).toBeInstanceOf(ListParseError);
  });
});

describe('header detection', () => {
  it('skips a title line above the table: the header is the first row with two filled cells', async () => {
    const out = await parseList(csv('Projects per 1 October;;\n;;\nCode;Name;Owner\nP-1;Atlas;Ann'));
    expect(out.headerRow).toBe(3);
    expect(out.columns).toEqual(['Code', 'Name', 'Owner']);
    expect(out.rows).toEqual([{ Code: 'P-1', Name: 'Atlas', Owner: 'Ann' }]);
  });

  it('takes the first non-empty row of a one-column list', async () => {
    const out = await parseList(csv('\nName\nAtlas\nBeacon'));
    expect(out.headerRow).toBe(2);
    expect(out.columns).toEqual(['Name']);
    expect(out.rows).toHaveLength(2);
  });

  it('reads an export without a header row: the first line is data, columns are numbered, empty trailing columns dropped', async () => {
    const out = await parseList(csv('2020;januari;"Ann Example";_Intern;"52,00";;\n2020;februari;"Bob Example";Contoso;"8,00";;\n'));
    expect(out.headerRow).toBe(0);
    expect(out.columns).toEqual(['Column 1', 'Column 2', 'Column 3', 'Column 4', 'Column 5']);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toEqual({ 'Column 1': '2020', 'Column 2': 'januari', 'Column 3': 'Ann Example', 'Column 4': '_Intern', 'Column 5': '52,00' });
  });

  it('a header that merely contains digits is still a header', async () => {
    const out = await parseList(csv('Code 1;ISO 27001;Name\nP-1;ja;Atlas\n'));
    expect(out.headerRow).toBe(1);
    expect(out.columns).toEqual(['Code 1', 'ISO 27001', 'Name']);
    expect(looksLikeData(['Code', '2020'])).toBe(true);
    expect(looksLikeData(['Code', '1,5'])).toBe(true);
    expect(looksLikeData(['ISO 27001', 'v2'])).toBe(false);
  });

  it('findHeaderIndex answers -1 when every row is blank', () => {
    expect(findHeaderIndex([[''], [' ', '']])).toBe(-1);
    expect(findHeaderIndex([['t', ''], ['a', 'b']])).toBe(1);
    expect(findHeaderIndex([['t', ''], ['u']])).toBe(0);
  });
});

describe('sniffDelimiter', () => {
  it('picks the delimiter that occurs most on the header line, ignoring quoted text', () => {
    expect(sniffDelimiter('a;b;c\n1,2,3,4,5')).toBe(';');
    expect(sniffDelimiter('a,b;c,d')).toBe(',');
    expect(sniffDelimiter('a\tb\tc;d')).toBe('\t');
    expect(sniffDelimiter('"x;y;z",b')).toBe(',');
    expect(sniffDelimiter('\n\nname')).toBe(',');
  });
  it('breaks a tie towards the earlier of ; , TAB', () => {
    expect(sniffDelimiter('a;b,c')).toBe(';');
    expect(sniffDelimiter('a,b\tc')).toBe(',');
  });
});

describe('parseCsv', () => {
  it('handles CR-only line ends and a last line without a line end', () => {
    expect(parseCsv('a,b\r1,2', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('keeps a trailing empty field', () => {
    expect(parseCsv('a,b,\n', ',')).toEqual([['a', 'b', '']]);
  });
});

describe('headerNames', () => {
  it('drops trailing empty header cells and avoids a generated name that is already taken', () => {
    expect(headerNames(['a', '', 'Column 2', ' ', 'z', '', ' '])).toEqual(['a', 'Column 2 (2)', 'Column 2', 'Column 4', 'z']);
  });
});

describe('detectFormat', () => {
  it('reads a zip as xlsx and anything else as csv', () => {
    expect(detectFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), 'x.bin')).toBe('xlsx');
    expect(detectFormat(Buffer.from('a,b'), 'list.csv', 'text/csv')).toBe('csv');
    expect(detectFormat(Buffer.from('PK'), 'list.txt')).toBe('csv');
  });
  it('refuses an old .xls (by magic or name) and a file that claims to be xlsx but is not', () => {
    expect(() => detectFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1]), 'a.bin')).toThrow(/old-style \.xls/);
    expect(() => detectFormat(Buffer.from('a,b'), 'A.XLS')).toThrow(/old-style/);
    expect(() => detectFormat(Buffer.from('a,b'), 'a.xlsx')).toThrow(/not one/);
    expect(() => detectFormat(Buffer.from('a,b'), 'a', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toThrow(ListParseError);
  });
});

describe('cellToString', () => {
  it('turns every ExcelJS value shape into a string', () => {
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
    expect(cellToString(42.5)).toBe('42.5');
    expect(cellToString(true)).toBe('true');
    expect(cellToString(new Date(Date.UTC(2026, 9, 1)))).toBe('2026-10-01T00:00:00.000Z');
    expect(cellToString({ formula: 'A1*2', result: 7 })).toBe('7');
    expect(cellToString({ sharedFormula: 'A1', result: 'x' })).toBe('x');
    expect(cellToString({ formula: 'NOW()' })).toBe('');
    expect(cellToString({ richText: [{ text: 'Con' }, { text: 'toso' }, {}] })).toBe('Contoso');
    expect(cellToString({ text: 'site', hyperlink: 'https://example.com' })).toBe('site');
    expect(cellToString({ error: '#N/A' })).toBe('#N/A');
    expect(cellToString({})).toBe('');
  });
});

describe('parseList — xlsx', () => {
  it('reads the first worksheet from its first non-empty row, with dates and formulas as values', async () => {
    const buf = await xlsxOf((wb) => {
      const ws = wb.addWorksheet('Projects');
      ws.getRow(1).values = ['Project list, October'];
      ws.getRow(3).values = ['Code', 'Name', 'Start', 'Budget'];
      ws.getRow(4).values = ['P-1', 'Atlas', new Date(Date.UTC(2026, 0, 2)), { formula: '2*5', result: 10 }];
      ws.getRow(6).values = ['P-2', { richText: [{ text: 'Bea' }, { text: 'con' }] }];
      wb.addWorksheet('Ignored').getRow(1).values = ['Nope'];
    });
    const out = await parseList(buf, { fileName: 'projects.xlsx' });
    expect(out.columns).toEqual(['Code', 'Name', 'Start', 'Budget']);
    expect(out.headerRow).toBe(3);
    expect(out.rows).toEqual([
      { Code: 'P-1', Name: 'Atlas', Start: '2026-01-02T00:00:00.000Z', Budget: '10' },
      { Code: '', Name: '', Start: '', Budget: '' },
      { Code: 'P-2', Name: 'Beacon', Start: '', Budget: '' },
    ]);
  });

  it('refuses a workbook without a worksheet, a corrupt zip, and a sheet with no header', async () => {
    const none = await xlsxOf(() => {});
    expect((await refusal(parseList(none))).message).toMatch(/no worksheet|could not be read/);
    const corrupt = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage')]);
    const bad = await refusal(parseList(corrupt, { fileName: 'x.xlsx' }));
    expect(bad).toBeInstanceOf(ListParseError);
    expect(bad.message).toMatch(/could not be read/);
    const empty = await xlsxOf((wb) => { wb.addWorksheet('Empty'); });
    expect((await refusal(parseList(empty))).message).toMatch(/no header row/);
  });
});
