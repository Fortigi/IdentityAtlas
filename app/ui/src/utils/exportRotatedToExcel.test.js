import { describe, it, expect, vi } from 'vitest';
import { buildRotatedWorkbook, exportRotatedToExcel } from './exportRotatedToExcel.js';
import { triggerDownload } from './exportToExcel.helpers';

// Only the download is replaced (it needs a DOM); the legend sheet stays real.
vi.mock('./exportToExcel.helpers', async importOriginal => ({
  ...(await importOriginal()),
  triggerDownload: vi.fn().mockResolvedValue(undefined),
}));

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
    // Both header rows are rotated over the resource columns, not only the names.
    expect(ws.getCell(1, 4).alignment.textRotation).toBe(90);
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
    expect(ws.getCell(4, 5).fill).toEqual({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } });
    // Bob has no job title: the cell is an empty string, not a placeholder.
    expect(ws.getCell(4, 3).value).toBe('');
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

  it('names the app as the workbook author', () => {
    expect(buildRotatedWorkbook(makeOpts()).creator).toBe('Identity Atlas');
  });

  it('sizes the three info columns wide and exactly one narrow column per resource', () => {
    const ws = buildRotatedWorkbook(makeOpts()).getWorksheet('Role Mining Matrix');
    expect([1, 2, 3, 4, 5, 6, 7].map(c => ws.getColumn(c).width)).toEqual([32, 22, 22, 4, 4, 4, undefined]);
  });

  it('lists no active filters on the legend: the rotated export carries none', () => {
    const legend = buildRotatedWorkbook(makeOpts()).getWorksheet('Legend');
    const texts = [];
    legend.eachRow(r => r.eachCell(c => texts.push(c.value)));
    expect(texts).not.toContain('Active Filters');
  });
});

describe('exportRotatedToExcel', () => {
  it('stamps the creation time and downloads the workbook under the unfiltered name', async () => {
    triggerDownload.mockClear();
    const before = Date.now();
    await exportRotatedToExcel(makeOpts());
    expect(triggerDownload).toHaveBeenCalledTimes(1);
    const [wb, activeFilters] = triggerDownload.mock.calls[0];
    expect(wb.getWorksheet('Role Mining Matrix').getCell(3, 1).value).toBe('Alice Eng');
    expect(wb.created.getTime()).toBeGreaterThanOrEqual(before);
    expect(activeFilters).toEqual([]);
  });
});
