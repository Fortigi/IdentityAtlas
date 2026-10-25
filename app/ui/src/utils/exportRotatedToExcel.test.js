import { describe, it, expect } from 'vitest';
import { buildRotatedWorkbook } from './exportRotatedToExcel.js';

// Two subjects × three resources; Alice holds two types on one resource
// (rich text), Bob a single governed grant, and one cell stays empty — so a
// transposed or off-by-one layout lands a value in the wrong cell.
function makeOpts(extra = {}) {
  return {
    users: [
      { id: 'u1', displayName: 'Alice Eng', department: 'Engineering', jobTitle: 'Developer' },
      { id: 'u2', displayName: '=Bob', department: 'Sales', jobTitle: '' },
    ],
    resources: [
      { id: 'r1', displayName: 'Finance App', resourceType: 'Group' },
      { id: 'r2', displayName: 'HR Portal', resourceType: 'Group' },
      { id: 'r3', displayName: 'CRM Role', resourceType: '' },
    ],
    cellMap: new Map([
      ['u1|r1', { types: new Set(['Direct', 'Indirect']), managed: false }],
      ['u1|r3', { types: new Set(['Eligible']), managed: false }],
      ['u2|r2', { types: new Set(['Direct']), managed: true }],
    ]),
    ...extra,
  };
}

describe('buildRotatedWorkbook', () => {
  it('produces a real .xlsx workbook', async () => {
    const buf = await buildRotatedWorkbook(makeOpts()).xlsx.writeBuffer();
    expect(Buffer.from(buf.slice(0, 2)).toString('latin1')).toBe('PK');
  });

  it('writes the resource-type and resource-name header rows', () => {
    const ws = buildRotatedWorkbook(makeOpts()).getWorksheet('Role Mining Matrix');
    expect(ws.getRow(1).values.slice(1)).toEqual(['Subjects', undefined, undefined, 'Group', 'Group', '(no type)']);
    expect(ws.getRow(2).values.slice(1)).toEqual(['Display Name', 'Department', 'Job Title', 'Finance App', 'HR Portal', 'CRM Role']);
    expect(ws.getCell(2, 4).alignment.textRotation).toBe(90);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 3, ySplit: 2 });
  });

  it('puts each subject on its own row with membership letters under the right resource', () => {
    const ws = buildRotatedWorkbook(makeOpts()).getWorksheet('Role Mining Matrix');
    expect(ws.getCell(3, 1).value).toBe('Alice Eng');
    expect(ws.getCell(3, 2).value).toBe('Engineering');
    expect(ws.getCell(3, 3).value).toBe('Developer');
    // Alice: two types on Finance App → rich text D + I; nothing on HR Portal; E on CRM Role.
    expect(ws.getCell(3, 4).value.richText.map(t => t.text).join('')).toBe('DI');
    expect(ws.getCell(3, 5).value).toBeNull();
    expect(ws.getCell(3, 6).value).toBe('E');
    // Bob: only HR Portal, governed → blue fill; his ungoverned neighbours stay unfilled.
    expect(ws.getCell(4, 4).value).toBeNull();
    expect(ws.getCell(4, 5).value).toBe('D');
    expect(ws.getCell(4, 5).fill.fgColor.argb).toBe('FFDBEAFE');
    expect(ws.getCell(3, 6).fill).toBeUndefined();
  });

  it('guards subject names against formula injection', () => {
    const ws = buildRotatedWorkbook(makeOpts()).getWorksheet('Role Mining Matrix');
    expect(ws.getCell(4, 1).value).toBe("'=Bob");
  });

  it('adds the legend sheet with the shareable link', () => {
    const wb = buildRotatedWorkbook(makeOpts({ shareUrl: 'https://atlas.example/m?x=1' }));
    const legend = wb.getWorksheet('Legend');
    const texts = [];
    legend.eachRow(r => r.eachCell(c => texts.push(c.value?.hyperlink || c.value)));
    expect(texts).toContain('https://atlas.example/m?x=1');
  });
});
