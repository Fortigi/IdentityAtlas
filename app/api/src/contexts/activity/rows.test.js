import { describe, it, expect } from 'vitest';
import { readActivityRows, MAX_SKIPPED_SAMPLES } from './rows.js';

const mapping = {
  sourceLabel: 'Clockify', contextColumn: 'Client', subjectNameColumn: 'User', subjectEmailColumn: 'Email',
  dateColumn: 'Date', dateOrder: 'dmy', amountColumn: 'Hours', unit: 'hours', kindColumn: 'Task', attributeColumns: ['Note'],
};
const row = (over) => ({ Client: 'Northwind Traders', User: 'Vera Example', Email: 'Vera@Example.org', Date: '18-04-2026', Hours: '1,5', Task: 'Build', Note: '', ...over });

describe('readActivityRows', () => {
  it('reads one entry per row, the address folded to lower case', () => {
    const { entries, period } = readActivityRows([row({ Note: 'kick-off' })], mapping);
    expect(entries).toEqual([{
      contextValue: 'Northwind Traders', subjectName: 'Vera Example', subjectEmail: 'vera@example.org',
      date: '2026-04-18', amount: 1.5, kind: 'Build', attributes: { Note: 'kick-off' },
    }]);
    expect(period).toEqual({ start: '2026-04-18', end: '2026-04-18' });
  });

  it('the period spans the earliest and the latest readable row, whatever their order', () => {
    const { period } = readActivityRows([row({ Date: '10-04-2026' }), row({ Date: '02-01-2026' }), row({ Date: '30-03-2026' }), row({ Date: 'bad' })], mapping);
    expect(period).toEqual({ start: '2026-01-02', end: '2026-04-10' });
  });

  it('skips and counts a row without a date, an amount or a person — and samples it by data row', () => {
    const r = readActivityRows([
      row(), row({ Date: '' }), row({ Hours: 'soon' }), row({ Hours: '-2' }), row({ User: '', Email: '' }),
    ], mapping);
    expect(r.entries).toHaveLength(1);
    expect(r.skipped).toEqual({ 'no date': 1, 'no amount': 2, 'no person': 1 });
    expect(r.skippedSamples).toEqual([{ row: 2, reason: 'no date' }, { row: 3, reason: 'no amount' }, { row: 4, reason: 'no amount' }, { row: 5, reason: 'no person' }]);
  });

  it('keeps at most the first MAX_SKIPPED_SAMPLES samples but counts every skipped row', () => {
    const rows = Array.from({ length: MAX_SKIPPED_SAMPLES + 1 }, () => row({ Date: '' }));
    const r = readActivityRows(rows, mapping);
    expect(r.skipped['no date']).toBe(MAX_SKIPPED_SAMPLES + 1);
    expect(r.skippedSamples).toHaveLength(MAX_SKIPPED_SAMPLES);
    expect(r.period).toBeNull();
  });

  it('a name cell that is an address, without an e-mail column, becomes the address', () => {
    const m = { ...mapping, subjectEmailColumn: null };
    expect(readActivityRows([row({ User: 'Tom@Example.org' })], m).entries[0]).toMatchObject({ subjectName: null, subjectEmail: 'tom@example.org' });
    expect(readActivityRows([row({ User: 'Tom Sample' })], m).entries[0]).toMatchObject({ subjectName: 'Tom Sample', subjectEmail: null });
  });

  it('an e-mail cell that is no address is dropped, the name stays', () => {
    expect(readActivityRows([row({ Email: 'n/a' })], mapping).entries[0]).toMatchObject({ subjectName: 'Vera Example', subjectEmail: null });
  });

  it('reads SharePoint person cells: the lookup id and the claim prefix are dropped', () => {
    const m = { ...mapping, subjectEmailColumn: null };
    expect(readActivityRows([row({ User: 'Vera Example;#27' })], m).entries[0].subjectName).toBe('Vera Example');
    expect(readActivityRows([row({ User: 'i:0#.f|membership|vera@example.org' })], m).entries[0].subjectEmail).toBe('vera@example.org');
  });

  it('without an amount column every row is one event; without a context column no value is read', () => {
    const m = { ...mapping, amountColumn: null, unit: 'events', contextColumn: null, kindColumn: null, attributeColumns: [] };
    expect(readActivityRows([row()], m).entries[0]).toMatchObject({ amount: 1, contextValue: null, kind: null, attributes: null });
  });

  it('an empty sub-unit cell gives no context value (the service reports it)', () => {
    expect(readActivityRows([row({ Client: '  ' })], mapping).entries[0].contextValue).toBeNull();
  });

  it('caps an attribute value at 500 characters', () => {
    expect(readActivityRows([row({ Note: 'x'.repeat(600) })], mapping).entries[0].attributes.Note).toHaveLength(500);
  });
});
