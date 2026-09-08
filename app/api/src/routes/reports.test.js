// Unit tests for the report routes.
//
// The seam test at the bottom is the epic's Key Result in executable form: a
// template that the engine has never heard of is listed and served without a
// single edit to a route, the registry, or a renderer map.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';
import { registerReport } from '../reports/registry.js';
import { BUILT_IN_REPORTS } from '../reports/templates/index.js';
import reportsRouter from './reports.js';

const app = mountRouter(reportsRouter);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue(null);
  query.mockResolvedValue({ rows: [] });
});

describe('GET /api/reports', () => {
  it('lists every registered template with its form and columns', async () => {
    const res = await request(app).get('/api/reports').expect(200);

    expect(res.body.total).toBe(BUILT_IN_REPORTS.length);
    expect(res.body.data.map(r => r.name).sort()).toEqual(BUILT_IN_REPORTS.map(t => t.name).sort());
    for (const entry of res.body.data) {
      expect(entry.form).toBe('list');
      expect(entry.columns.length).toBeGreaterThan(0);
      for (const col of entry.columns) expect(col).toEqual({ key: expect.any(String), label: expect.any(String) });
      expect(entry.parametersSchema).toBeTruthy();
      // Metadata only — nothing executable crosses the wire.
      expect(entry.run).toBeUndefined();
    }
  });
});

describe('GET /api/reports/:name/rows', () => {
  it('returns the template metadata alongside its rows, count and generation time', async () => {
    query.mockResolvedValue({
      rows: [{ id: 'p1', displayName: 'Ada', email: 'ada@x', principalType: 'User', extendedAttributes: {}, systemName: 'Entra ID' }],
    });

    const res = await request(app).get('/api/reports/orphaned-accounts/rows').expect(200);

    expect(res.body).toMatchObject({ name: 'orphaned-accounts', form: 'list', total: 1 });
    expect(res.body.columns.length).toBe(5);
    expect(res.body.rows[0]).toMatchObject({ displayName: 'Ada', _entity: { kind: 'user', id: 'p1' } });
    expect(Date.parse(res.body.generatedAt)).not.toBeNaN();
  });

  it('returns an empty result — not an error — when the report finds nothing', async () => {
    const res = await request(app).get('/api/reports/orphaned-accounts/rows').expect(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('recomputes on every request, so a refresh reflects the latest data', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'p1', displayName: 'Ada', extendedAttributes: {} }] });
    query.mockResolvedValueOnce({ rows: [] });

    expect((await request(app).get('/api/reports/orphaned-accounts/rows')).body.total).toBe(1);
    expect((await request(app).get('/api/reports/orphaned-accounts/rows')).body.total).toBe(0);
  });

  it('404s on an unknown report name', async () => {
    const res = await request(app).get('/api/reports/not-a-report/rows').expect(404);
    expect(res.body).toEqual({ error: 'Report not found' });
  });

  it('404s rather than dispatching on an inherited Object.prototype key', async () => {
    await request(app).get('/api/reports/constructor/rows').expect(404);
    await request(app).get('/api/reports/toString/rows').expect(404);
  });
});

describe('a failing template', () => {
  let unregister;
  let errorSpy;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unregister = registerReport({
      name: 'exploding-report', displayName: 'Exploding', description: 'Always throws.',
      form: 'list', parametersSchema: { type: 'object', required: [], properties: {} },
      columns: [{ key: 'a', label: 'A' }],
      run: async () => { throw new Error('relation "Secrets" does not exist'); },
    });
  });
  afterEach(() => { unregister(); errorSpy.mockRestore(); });

  it('returns a generic 500 and keeps the detail in the server log', async () => {
    const res = await request(app).get('/api/reports/exploding-report/rows').expect(500);

    expect(res.body).toEqual({ error: 'Failed to run report' });
    expect(JSON.stringify(res.body)).not.toMatch(/Secrets/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('exploding-report'), 'relation "Secrets" does not exist');
  });
});

describe('the seam — adding a report costs only a template', () => {
  let unregister;
  afterEach(() => unregister?.());

  it('lists and serves a template the engine has never heard of', async () => {
    unregister = registerReport({
      name: 'dummy-seam-report',
      displayName: 'Dummy Seam Report',
      description: 'Registered by the test, not by the engine.',
      form: 'list',
      parametersSchema: { type: 'object', required: [], properties: {} },
      columns: [{ key: 'thing', label: 'Thing' }, { key: 'count', label: 'Count' }],
      run: async (params) => ({ rows: [{ thing: params.thing || 'widget', count: 3 }] }),
    });

    const list = await request(app).get('/api/reports').expect(200);
    expect(list.body.data.find(r => r.name === 'dummy-seam-report')).toMatchObject({
      displayName: 'Dummy Seam Report',
      form: 'list',
      columns: [{ key: 'thing', label: 'Thing' }, { key: 'count', label: 'Count' }],
    });

    const rows = await request(app).get('/api/reports/dummy-seam-report/rows').expect(200);
    expect(rows.body).toMatchObject({ total: 1, rows: [{ thing: 'widget', count: 3 }] });
    // Query parameters reach the template as its parameters.
    const parameterised = await request(app).get('/api/reports/dummy-seam-report/rows?thing=sprocket').expect(200);
    expect(parameterised.body.rows[0].thing).toBe('sprocket');
  });
});
