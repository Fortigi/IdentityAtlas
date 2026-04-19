// Smoke tests for the Excel Power Query workbook generator. We don't try to
// validate the full XLSX schema — exceljs handles that — but we do pin the
// shape of the output so a regression in sheet naming, named ranges, or M
// content fails CI rather than producing a workbook that opens but has the
// wrong tabs / missing token.

import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { generateWorkbook } from './excelWorkbook.js';
import { QUERIES } from './queryTemplates.js';

const FIXTURE = {
  apiBaseUrl: 'http://localhost:3001/api',
  token: 'fgr_unit-test-token-value',
};

describe('generateWorkbook', () => {
  let buffer;
  let wb;

  beforeAll(async () => {
    buffer = await generateWorkbook(FIXTURE);
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
  });

  it('returns a non-empty Buffer', () => {
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(2000);
  });

  it('opens cleanly with exceljs (round-trip)', () => {
    expect(wb.worksheets.length).toBeGreaterThan(0);
  });

  it('includes the README and Settings sheets first', () => {
    expect(wb.worksheets[0].name).toBe('README');
    expect(wb.worksheets[1].name).toBe('Settings');
  });

  it('writes the supplied apiBaseUrl and token into the Settings sheet', () => {
    const settings = wb.getWorksheet('Settings');
    expect(settings.getCell('B2').value).toBe(FIXTURE.apiBaseUrl);
    expect(settings.getCell('B3').value).toBe(FIXTURE.token);
  });

  it('defines named ranges BaseUrl and AuthToken pointing at the Settings cells', () => {
    // The M code references the names — if they go missing every query
    // breaks at refresh time. Use exceljs's resolution API so we don't
    // depend on the internal model representation.
    const baseUrlRanges = wb.definedNames.getRanges('BaseUrl');
    const tokenRanges = wb.definedNames.getRanges('AuthToken');
    expect(baseUrlRanges?.ranges?.length || 0).toBeGreaterThan(0);
    expect(tokenRanges?.ranges?.length || 0).toBeGreaterThan(0);
    // Both names should resolve to a Settings-sheet cell — exact ref isn't
    // load-bearing as long as the cell value is right (verified above).
    expect(JSON.stringify(baseUrlRanges)).toMatch(/Settings/);
    expect(JSON.stringify(tokenRanges)).toMatch(/Settings/);
  });

  it('emits one sheet per object type defined in queryTemplates', () => {
    for (const q of QUERIES) {
      expect(wb.getWorksheet(q.sheet)).toBeDefined();
    }
  });

  it('puts the M code on each query sheet, with the Excel.CurrentWorkbook lookups intact', () => {
    for (const q of QUERIES) {
      const sheet = wb.getWorksheet(q.sheet);
      const cell = sheet.getCell('A6').value;
      expect(typeof cell).toBe('string');
      // These two strings are the load-bearing parts of every query — they
      // wire the named ranges to the Power Query at refresh time. If they
      // vanish, the workbook is just a list of queries that ask the user
      // for credentials interactively, which defeats the whole feature.
      expect(cell).toContain('Excel.CurrentWorkbook(){[Name="BaseUrl"]}');
      expect(cell).toContain('Excel.CurrentWorkbook(){[Name="AuthToken"]}');
      // And it must reference the right endpoint
      expect(cell).toContain(q.endpoint);
    }
  });

  it('paginates by actual-rows-received rather than arithmetic over Total (so it adapts if server caps below PageSize)', () => {
    // Two failure modes this pins against:
    //   1. The original List.Generate had `[off] = [off] + PageSize` — a
    //      forward self-reference that silently stopped at 4 pages.
    //   2. A later attempt walked offsets arithmetically with
    //      Number.RoundUp(Total/PageSize); when /api/users capped rows at
    //      500 instead of 1000 that stopped at 4000/7911 rows.
    // Both are guarded by requiring the row-counting loop be in the M.
    const principals = wb.getWorksheet('Principals').getCell('A6').value;
    expect(principals).toContain('List.Count');         // tracks actual rows
    expect(principals).toContain('newOff');             // advance by what was returned
    expect(principals).not.toMatch(/off\s*=\s*\[off\]/); // old record-self-ref
  });

  it('auto-expands the extendedAttributes JSONB column', () => {
    // Users of the workbook expect sub-keys (userType, onPremisesSyncEnabled,
    // etc.) to appear as first-class columns, not "Record" cells they have
    // to click open one by one. The load-bearing bit: ExpandRecordColumn is
    // called against extendedAttributes with an ext_ prefix on the new
    // column names to avoid colliding with real columns.
    const principals = wb.getWorksheet('Principals').getCell('A6').value;
    expect(principals).toContain('extendedAttributes');
    expect(principals).toContain('Record.FieldNames');
    expect(principals).toMatch(/ext_/);
  });
});
