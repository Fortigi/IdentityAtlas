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

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

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
    });
    expect(await t.run()).toEqual({ rows: [{ displayName: 'Ann', _entity: { kind: 'user', id: 'u1' } }] });
    expect(runSpec).toHaveBeenCalledWith(DEFINITION);
  });

  it('a saved report that no longer validates fails loudly when run', async () => {
    runSpec.mockResolvedValueOnce({ ok: false, errors: ['"gone" is not a field of user'] });
    await expect(toReportTemplate(ROW).run()).rejects.toThrow(/no longer validates/);
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
