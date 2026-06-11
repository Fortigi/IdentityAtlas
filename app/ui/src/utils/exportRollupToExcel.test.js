import { describe, it, expect } from 'vitest';
import { buildRollupWorkbook } from './exportRollupToExcel.js';

describe('buildRollupWorkbook', () => {
  const opts = {
    rowNoun: 'Resource',
    columns: [{ key: 'HR', label: 'HR' }, { key: 'Finance', label: 'Finance' }],
    roleColumns: [{ id: 'r1', label: 'Payroll Admin' }],
    rows: [
      {
        label: 'SAP Finance', description: 'The finance system', total: 12,
        cell: (g) => ({ HR: 3, Finance: 9 }[g] || 0),
        roleCell: (id) => ({ r1: 4 }[id] || 0),
      },
    ],
  };

  it('produces a real .xlsx workbook (not CSV)', async () => {
    const wb = buildRollupWorkbook(opts);
    const buf = await wb.xlsx.writeBuffer();
    // .xlsx files are zip archives — they start with the "PK" signature.
    const head = Buffer.from(buf.slice(0, 2)).toString('latin1');
    expect(head).toBe('PK');
  });

  it('lays out the header and a data row matching the grid', () => {
    const wb = buildRollupWorkbook(opts);
    const ws = wb.getWorksheet('Roll-up');
    const header = ws.getRow(1).values; // 1-based; [empty, ...]
    expect(header.slice(1)).toEqual(['Resource', 'HR', 'Finance', 'Payroll Admin', '#', 'Description']);
    const r = ws.getRow(2).values;
    expect(r[1]).toBe('SAP Finance');
    expect(r[2]).toBe(3);   // HR
    expect(r[3]).toBe(9);   // Finance
    expect(r[4]).toBe(4);   // Payroll Admin role count
    expect(r[5]).toBe(12);  // total
    expect(r[6]).toBe('The finance system');
  });

  it('leaves zero cells empty rather than writing 0', () => {
    const wb = buildRollupWorkbook({
      ...opts,
      rows: [{ label: 'X', description: '', total: 0, cell: () => 0, roleCell: () => 0 }],
    });
    const r = wb.getWorksheet('Roll-up').getRow(2).values;
    expect(r[2]).toBeUndefined();
    expect(r[3]).toBeUndefined();
  });
});
