import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('./service.js', () => ({
  loadValues: vi.fn(async () => ({ userType: ['Guest', 'Member'] })),
  runSpec: vi.fn(async () => ({ ok: true, rows: [{ displayName: 'Ann', _entity: { kind: 'user', id: 'u1' } }] })),
}));

import { query, queryOne } from '../db/connection.js';
import { runSpec } from './service.js';
import { listAllReports, resolveReport, reportMetadata } from '../reports/registry.js';
import {
  prepareSavedReport, createSavedReport, updateSavedReport, deleteSavedReport, getSavedReport, toReportTemplate,
} from './savedReports.js';

const ID = '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab';
const DEFINITION = { entity: 'user', conditions: [{ field: 'userType', op: 'eq', value: 'guest' }], columns: ['displayName'] };
const ROW = { id: ID, name: 'Guests', description: null, definition: DEFINITION, question: 'all guests' };

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  // Custom reports are experimental: the report source only answers while the
  // flag is on (USE_SQL is off in unit tests, so the env default decides).
  process.env.FEATURE_CUSTOM_REPORTS = 'true';
});

describe('prepareSavedReport', () => {
  it('trims, normalises the definition and drops empty optional text', async () => {
    const { value, errors } = await prepareSavedReport({ name: '  Guests ', description: '  ', definition: DEFINITION });
    expect(errors).toBeUndefined();
    expect(value).toEqual({
      name: 'Guests', description: null, question: null,
      definition: { entity: 'user', match: 'all', conditions: [{ type: 'field', field: 'userType', op: 'eq', value: 'Guest' }], columns: ['displayName'], limit: 1000 },
    });
  });

  it('collects a missing name and every definition error together', async () => {
    const { errors } = await prepareSavedReport({ name: '', definition: { entity: 'user', conditions: [{ field: 'nope', op: 'eq', value: 1 }] } });
    expect(errors[0]).toBe('A name is required');
    expect(errors[1]).toMatch(/"nope" is not a field of user/);
  });
});

describe('storage', () => {
  it('reports a duplicate name as a conflict instead of throwing', async () => {
    queryOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    expect(await createSavedReport({ name: 'Guests', definition: {} }, 'wim')).toEqual({ conflict: true });
    queryOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    expect(await updateSavedReport(ID, { name: 'Guests', definition: {} }, 'wim')).toEqual({ conflict: true });
  });

  it('rethrows other database errors', async () => {
    queryOne.mockRejectedValueOnce(new Error('connection lost'));
    await expect(createSavedReport({ name: 'x', definition: {} }, 'wim')).rejects.toThrow('connection lost');
  });

  it('never queries with an id that is not a uuid', async () => {
    expect(await getSavedReport("1' OR '1'='1")).toBeNull();
    expect(await updateSavedReport('abc', {}, 'wim')).toBeNull();
    expect(await deleteSavedReport('abc')).toBe(false);
    expect(queryOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('delete reports whether a row was removed', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    expect(await deleteSavedReport(ID)).toBe(true);
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await deleteSavedReport(ID)).toBe(false);
  });
});

describe('saved reports in the report registry', () => {
  it('shapes a saved report as an editable list report with compiled columns', async () => {
    const t = toReportTemplate(ROW);
    expect(reportMetadata(t)).toMatchObject({
      name: `custom-${ID}`, displayName: 'Guests', form: 'list',
      columns: [{ key: 'displayName', label: 'Name' }], editable: { builderId: ID },
      source: 'custom',
    });
    expect(await t.run()).toEqual({ rows: [{ displayName: 'Ann', _entity: { kind: 'user', id: 'u1' } }], truncated: false });
    // A run that stopped at the definition's row limit says so, instead of passing
    // the first rows off as the whole answer.
    runSpec.mockResolvedValueOnce({ ok: true, rows: [{ displayName: 'Ann' }], truncated: true });
    expect((await t.run()).truncated).toBe(true);
    expect(runSpec).toHaveBeenCalledWith(DEFINITION);
  });

  it('says who built a saved report and who changed it last, with the time as ISO text', () => {
    // Postgres hands back a Date; the list is JSON, so it must not arrive as {}.
    const updatedAt = new Date('2026-09-16T08:30:00Z');
    const t = toReportTemplate({ ...ROW, createdBy: 'ann@example.com', updatedBy: 'bob@example.com', updatedAt });
    expect(reportMetadata(t).author).toEqual({
      createdBy: 'ann@example.com', updatedBy: 'bob@example.com', updatedAt: '2026-09-16T08:30:00.000Z',
    });
    // A row from before anyone was recorded still lists, with nothing invented.
    expect(reportMetadata(toReportTemplate(ROW)).author).toEqual({ createdBy: null, updatedBy: null, updatedAt: null });
  });

  it('a saved report that no longer validates fails loudly when run', async () => {
    runSpec.mockResolvedValueOnce({ ok: false, errors: ['"gone" is not a field of user'] });
    await expect(toReportTemplate(ROW).run()).rejects.toThrow(/no longer validates/);
  });

  it('is invisible while the feature is switched off', async () => {
    process.env.FEATURE_CUSTOM_REPORTS = 'false';
    query.mockResolvedValueOnce({ rows: [ROW] });
    expect((await listAllReports()).map(r => r.name)).not.toContain(`custom-${ID}`);
    queryOne.mockResolvedValueOnce(ROW);
    expect(await resolveReport(`custom-${ID}`)).toBeNull();
  });

  it('is listed next to the built-ins and resolved by name', async () => {
    query.mockResolvedValueOnce({ rows: [ROW] });
    const names = (await listAllReports()).map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(['orphaned-accounts', `custom-${ID}`]));

    queryOne.mockResolvedValueOnce(ROW);
    expect((await resolveReport(`custom-${ID}`)).displayName).toBe('Guests');
    expect(await resolveReport('custom-not-a-uuid')).toBeNull();
    expect(await resolveReport('something-else')).toBeNull();
  });
});
