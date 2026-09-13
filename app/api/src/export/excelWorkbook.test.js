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
    // Three previous bugs this pins against:
    //   1. List.Generate with `[off] = [off] + PageSize` — record
    //      self-reference stopped at 4 pages (4,000/7,911).
    //   2. Arithmetic walk with Number.RoundUp(Total/PageSize) stopped
    //      when server capped below PageSize (4,000 again).
    //   3. `done`-flag variant dropped the tail partial page: when
    //      newOff >= Total the condition flipped false on the same
    //      state that held the rows, so the last 911 rows were never
    //      emitted (7,000/7,911).
    // The stable design: state carries "rows to emit" + "offset of next
    // fetch"; selector emits unconditionally; condition asks "does this
    // state have rows?"; next() short-circuits to an empty state when
    // there's nothing more to fetch so the next condition stops the loop.
    const principals = wb.getWorksheet('Principals').getCell('A6').value;
    expect(principals).toContain('List.Count');                      // counts actual rows
    expect(principals).toContain('nextOff');                         // offset of next fetch
    expect(principals).toContain('List.Count(state[rows]) > 0');     // condition based on emitted rows
    expect(principals).not.toMatch(/done\s*=/);                      // old boolean-flag pattern
    expect(principals).not.toMatch(/off\s*=\s*\[off\]/);             // old record-self-ref
  });

  it('pins includeBusinessRoles=true on the Resources feed so governance resources export', () => {
    // The /api/resources endpoint hides BusinessRole (access package / business
    // role) resources by default for the UI grid. Without this fixed query
    // param the export's Resources tab would silently omit the whole governance
    // (SOLL) layer, and the Contains edges in ResourceRelationships would point
    // at parent rows that aren't in the workbook.
    const resources = wb.getWorksheet('Resources').getCell('A6').value;
    expect(resources).toContain('includeBusinessRoles = "true"');
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

  // ─── Attribute display names (#872) ───────────────────────────────
  // The workbook header must be the string the browser shows. It gets there by
  // LOOKING UP /api/attribute-labels, not by a second copy of the strip rule in
  // M — a second copy is how the two would drift apart.

  it.each([
    ['Principals', 'principal'],
    ['Resources', 'resource'],
    ['Identities', 'identity'],
    ['Systems', 'system'],
  ])('titles %s columns from the /attribute-labels lookup for target=%s', (sheet, target) => {
    const m = wb.getWorksheet(sheet).getCell('A6').value;
    expect(m).toContain('RelativePath = "attribute-labels"');
    expect(m).toContain(`target = "${target}"`);
    expect(m).toContain('Record.FieldOrDefault(Labels, k, null)');
    // The rule itself must NOT be reimplemented here.
    expect(m).not.toMatch(/\[0-9a-f\]\{32\}/);
    expect(m).not.toContain('Text.AfterDelimiter');
  });

  it('keeps ext_<key> as the title for anything unlabelled, and as the collision fallback', () => {
    const m = wb.getWorksheet('Principals').getCell('A6').value;
    // No label ⇒ ext_<key>, so `userType` still exports as `ext_userType`.
    expect(m).toContain('names & { if usable then label else "ext_" & k }');
    // "usable" is exactly: labelled, not already a real column, not already taken
    // by an earlier expanded key — the guard that stops Power Query erroring on a
    // duplicate column name when a JSON key is literally called `displayName`.
    expect(m).toContain('List.RemoveItems(Table.ColumnNames(Expanded), {"extendedAttributes"})');
    expect(m).toContain('label <> null and not List.Contains(Taken, label) and not List.Contains(names, label)');
  });

  it('leaves the join-table feeds on plain ext_ naming with no extra request', () => {
    const m = wb.getWorksheet('Assignments').getCell('A6').value;
    expect(m).toContain('Labels = [],');
    expect(m).not.toContain('attribute-labels');
  });

  it('degrades to plain ext_ naming when the label endpoint is unreachable', () => {
    // `try … otherwise []` — an old server, a revoked token or a 500 must not
    // break the refresh; the workbook just falls back to the previous headers.
    const m = wb.getWorksheet('Principals').getCell('A6').value;
    expect(m).toMatch(/try Json\.Document[\s\S]*otherwise \[\]/);
  });
});
