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
import { EXPORT_FORMAT_NAMES } from '../reports/export.js';
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
      // The client offers the formats the server actually serves, rather than
      // assuming them.
      expect(entry.exportFormats).toEqual(EXPORT_FORMAT_NAMES);
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

describe('GET /api/reports/:name/export', () => {
  let unregister;

  beforeEach(() => {
    unregister = registerReport({
      name: 'downloadable-report',
      displayName: 'Downloadable Report',
      description: 'Two columns, one row.',
      form: 'list',
      parametersSchema: { type: 'object', required: [], properties: {} },
      columns: [{ key: 'thing', label: 'Thing' }, { key: 'count', label: 'Count' }],
      run: async (params) => ({ rows: [{ thing: params.thing || 'widget', count: 3 }] }),
    });
  });
  afterEach(() => unregister());

  it('serves CSV by default, as an attachment named after the report and the day', async () => {
    const res = await request(app).get('/api/reports/downloadable-report/export').expect(200);

    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="identity-atlas-downloadable-report-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.text).toBe('"Thing","Count"\r\n"widget","3"');
  });

  it('serves JSON — the whole payload, rows included — when that format is asked for', async () => {
    const res = await request(app).get('/api/reports/downloadable-report/export?format=json').expect(200);

    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toMatch(/filename=".*\.json"$/);
    expect(JSON.parse(res.text)).toMatchObject({
      name: 'downloadable-report', total: 1, rows: [{ thing: 'widget', count: 3 }],
    });
  });

  it('downloads exactly what the rows endpoint served — same columns, same rows', async () => {
    const rows = await request(app).get('/api/reports/downloadable-report/rows').expect(200);
    const download = await request(app).get('/api/reports/downloadable-report/export?format=json').expect(200);

    const { generatedAt: a, ...served } = rows.body;
    const { generatedAt: b, ...downloaded } = JSON.parse(download.text);
    expect(downloaded).toEqual(served);
    expect(Date.parse(a)).not.toBeNaN();
    expect(Date.parse(b)).not.toBeNaN();
  });

  it('passes the other query parameters to the template, and `format` only to itself', async () => {
    const res = await request(app)
      .get('/api/reports/downloadable-report/export?format=csv&thing=sprocket').expect(200);

    expect(res.text).toBe('"Thing","Count"\r\n"sprocket","3"');
  });

  it('400s on a format it does not serve, naming the ones it does', async () => {
    const res = await request(app).get('/api/reports/downloadable-report/export?format=xlsx').expect(400);

    expect(res.body.error).toContain('Unsupported export format');
    for (const name of EXPORT_FORMAT_NAMES) expect(res.body.error).toContain(name);
  });

  it('400s rather than dispatching on an inherited Object.prototype key', async () => {
    await request(app).get('/api/reports/downloadable-report/export?format=constructor').expect(400);
    await request(app).get('/api/reports/downloadable-report/export?format=toString').expect(400);
  });

  it('404s on an unknown report name, before it looks at the format', async () => {
    const res = await request(app).get('/api/reports/not-a-report/export?format=csv').expect(404);
    expect(res.body).toEqual({ error: 'Report not found' });
  });

  it('recomputes on every download, so a re-download reflects the latest data', async () => {
    const first = await request(app).get('/api/reports/downloadable-report/export?thing=one').expect(200);
    const second = await request(app).get('/api/reports/downloadable-report/export?thing=two').expect(200);

    expect(first.text).toContain('"one"');
    expect(second.text).toContain('"two"');
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

  it('fails the download the same way — a generic 500, never a half-written file', async () => {
    const res = await request(app).get('/api/reports/exploding-report/export').expect(500);

    expect(res.body).toEqual({ error: 'Failed to run report' });
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('exploding-report/export'), 'relation "Secrets" does not exist');
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

    // …and it is downloadable, in every format, on the same terms.
    for (const format of EXPORT_FORMAT_NAMES) {
      const download = await request(app).get(`/api/reports/dummy-seam-report/export?format=${format}`).expect(200);
      expect(download.headers['content-disposition']).toContain(`.${format}"`);
      expect(download.text).toContain('widget');
    }
  });
});
