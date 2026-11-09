// What an added source becomes as text: a transcript as before, a list as one
// readable line per row, pasted text tidied — each refused with a sentence.
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { readSourceText, rowsToText, LIST_FILE } from './sourceText.js';
import { TranscriptError } from './transcript.js';
import { PASTED_TEXT_NAME } from './store.js';

const file = (content, originalname) => ({ buffer: Buffer.isBuffer(content) ? content : Buffer.from(content), originalname });

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Team');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('rowsToText', () => {
  it('one line per row, "Header: value" joined by "; ", empty cells and empty rows left out', () => {
    const text = rowsToText({
      columns: ['Name', 'Role', 'Status'],
      rows: [
        { Name: 'Ann Example', Role: 'Architect', Status: 'current' },
        { Name: 'Bob Sample', Role: '', Status: ' left ' },
        { Name: '', Role: '', Status: '' },
        { Name: 'Carl', Role: null, Status: undefined },
      ],
    });
    expect(text).toBe('Name: Ann Example; Role: Architect; Status: current\nName: Bob Sample; Status: left\nName: Carl');
  });
});

describe('readSourceText', () => {
  it('a csv list: its rows as lines, the original file name kept', async () => {
    const r = await readSourceText({ file: file('Name;Role\nAnn Example;Architect\nBob Sample;Developer\n', 'team.csv') });
    expect(r).toEqual({ text: 'Name: Ann Example; Role: Architect\nName: Bob Sample; Role: Developer', fileName: 'team.csv', format: 'list' });
  });

  it('an xlsx list: the first sheet, read the same way', async () => {
    const buffer = await xlsx([['Name', 'Role'], ['Ann Example', 'Architect'], ['Dana Said', 'Tester']]);
    const r = await readSourceText({ file: file(buffer, 'Team.XLSX') });
    expect(r.text).toBe('Name: Ann Example; Role: Architect\nName: Dana Said; Role: Tester');
    expect(r.fileName).toBe('Team.XLSX');
  });

  it('a transcript as before, with its format and file name; a file wins over text', async () => {
    const r = await readSourceText({ file: file('Ann: hello\r\n\r\n\r\nBob: hi', 'talk.txt'), text: 'ignored' });
    expect(r).toEqual({ text: 'Ann: hello\n\nBob: hi', format: 'txt', fileName: 'talk.txt' });
    expect((await readSourceText({ file: file('# Notes\nAnn left.', 'notes.md') })).text).toBe('# Notes\nAnn left.');
  });

  it('pasted text: tidied, stored under the pasted-text name', async () => {
    const r = await readSourceText({ text: '  Ann left in May.  \r\nBob stays. ' });
    expect(r).toEqual({ text: 'Ann left in May.\nBob stays.', fileName: PASTED_TEXT_NAME, format: 'text' });
  });

  it('refuses with a sentence: nothing, blank text, a list that cannot be read, an empty list', async () => {
    await expect(readSourceText({})).rejects.toThrow('Add a file or paste the text.');
    await expect(readSourceText({ text: '   ' })).rejects.toBeInstanceOf(TranscriptError);
    await expect(readSourceText({ text: 42 })).rejects.toBeInstanceOf(TranscriptError);
    await expect(readSourceText({ file: file('not a workbook', 'team.xlsx') })).rejects.toThrow(/not one; save it again/);
    await expect(readSourceText({ file: file('Name;Role\n', 'team.csv') })).rejects.toThrow('The transcript holds no text.');
    await expect(readSourceText({ file: file('', 'team.csv') })).rejects.toBeInstanceOf(TranscriptError);
  });

  it('only csv and xlsx are lists', () => {
    expect(['a.csv', 'B.XLSX'].every(n => LIST_FILE.test(n))).toBe(true);
    expect(['a.xls', 'a.csv.txt', 'a.docx'].some(n => LIST_FILE.test(n))).toBe(false);
  });
});
