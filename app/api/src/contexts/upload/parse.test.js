import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseList, parseCsv, sniffDelimiter, headerNames, findHeaderIndex, cellToString, detectFormat, ListParseError, MAX_ROWS } from './parse.js';

const csv = (text) => Buffer.from(text, 'utf8');

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Klanten');
  rows.forEach(r => ws.addRow(r));
  wb.addWorksheet('Second').addRow(['ignored', 'sheet']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('sniffDelimiter', () => {
  it.each([
    ['Naam;Eigenaar;Leden', ';'],
    ['Name,Owner,Members', ','],
    ['Name\tOwner\tMembers', '\t'],
    // Commas inside quotes do not count: two semicolons beat zero unquoted commas.
    ['"Doe, John";"a, b, c";x', ';'],
  ])('%j → %j', (text, expected) => {
    expect(sniffDelimiter(`${text}\nrow`)).toBe(expected);
  });

  it('a line without any delimiter is a one-column list (comma, harmless)', () => {
    expect(sniffDelimiter('Naam\nAcme')).toBe(',');
  });
});

describe('parseCsv', () => {
  it('keeps a quoted delimiter, a quoted line break and a doubled quote inside one field', () => {
    expect(parseCsv('a;"b;c";"line1\nline2";"say ""hi"""\r\nx;y;z;w', ';')).toEqual([
      ['a', 'b;c', 'line1\nline2', 'say "hi"'],
      ['x', 'y', 'z', 'w'],
    ]);
  });

  it('refuses a file that ends inside quotes', () => {
    expect(() => parseCsv('a,"b', ',')).toThrow(/closing quote/);
  });
});

describe('parseList — csv', () => {
  it('reads a semicolon list with a BOM: the first header is exactly "Naam", not "\\uFEFFNaam"', async () => {
    const { columns, rows } = await parseList(csv('﻿Naam;Eigenaar\nAcme;a@x.nl\n'), { fileName: 'klanten.csv' });
    expect(columns).toEqual(['Naam', 'Eigenaar']);
    expect(rows).toEqual([{ Naam: 'Acme', Eigenaar: 'a@x.nl' }]);
  });

  it('skips a title line above the header and drops blank rows', async () => {
    const { columns, rows } = await parseList(csv('Klanten per oktober\nNaam,Code\nAcme,1\n,\nBeta,2\n'));
    expect(columns).toEqual(['Naam', 'Code']);
    expect(rows.map(r => r.Code)).toEqual(['1', '2']);
  });

  it('trims cell values and fills a short row with empty strings', async () => {
    const { rows } = await parseList(csv('Naam,Code,Extra\n  Acme  ,1\n'));
    expect(rows[0]).toEqual({ Naam: 'Acme', Code: '1', Extra: '' });
  });

  it('accepts exactly MAX_ROWS data rows and refuses one more', async () => {
    const body = (n) => `Naam,Code\n${Array.from({ length: n }, (_, i) => `n${i},${i}`).join('\n')}`;
    await expect(parseList(csv(body(MAX_ROWS)))).resolves.toMatchObject({ columns: ['Naam', 'Code'] });
    await expect(parseList(csv(body(MAX_ROWS + 1)))).rejects.toThrow(/more than 50,000 data rows/);
  });

  it('refuses an empty file and a file of blank lines', async () => {
    await expect(parseList(Buffer.alloc(0))).rejects.toThrow(ListParseError);
    await expect(parseList(csv('\n\n'))).rejects.toThrow(/no header row/);
  });
});

describe('parseList — xlsx', () => {
  it('reads the first worksheet only, numbers and dates as strings', async () => {
    const buf = await xlsx([['Naam', 'Sinds', 'Nummer'], ['Acme', new Date('2026-01-02T00:00:00Z'), 42]]);
    const { columns, rows } = await parseList(buf, { fileName: 'klanten.xlsx' });
    expect(columns).toEqual(['Naam', 'Sinds', 'Nummer']);
    expect(rows).toEqual([{ Naam: 'Acme', Sinds: '2026-01-02T00:00:00.000Z', Nummer: '42' }]);
  });

  it('refuses an old .xls and a file named .xlsx that is not a workbook', async () => {
    expect(() => detectFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0]), 'a.bin')).toThrow(/old-style \.xls/);
    expect(() => detectFormat(csv('Naam,Code'), 'list.xlsx')).toThrow(/not one/);
    expect(detectFormat(csv('Naam,Code'), 'list.csv')).toBe('delimited');
  });
});

describe('cellToString', () => {
  it.each([
    [null, ''],
    [7, '7'],
    [{ formula: 'A1+1', result: 3 }, '3'],
    [{ richText: [{ text: 'Ac' }, { text: 'me' }] }, 'Acme'],
    [{ text: 'link', hyperlink: 'https://x' }, 'link'],
    [{ error: '#N/A' }, '#N/A'],
    [{ something: 1 }, ''],
  ])('%j → %j', (value, expected) => {
    expect(cellToString(value)).toBe(expected);
  });
});

describe('headerNames / findHeaderIndex', () => {
  it('names an empty or repeated header by its position, without colliding with a real one', () => {
    expect(headerNames(['Naam', '', 'Naam', 'Column 2', ' '])).toEqual(['Naam', 'Column 2 (2)', 'Column 3', 'Column 2']);
  });

  it('a one-column list takes its first non-empty row as the header', () => {
    expect(findHeaderIndex([[''], ['Naam'], ['Acme']])).toBe(1);
  });
});
