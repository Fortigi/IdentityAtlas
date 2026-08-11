// Coverage unit tests for routes/contextPlugins.js — exercises every endpoint's
// happy path and error branch with the DB, plugin registry, runner, and column
// cache all mocked. Complements contextPlugins.test.js (id validation + plugin
// 404 + trees 400) without duplicating its cases.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));

const getPlugin = vi.fn();
const PLUGIN = {
  name: 'manager-hierarchy', displayName: 'Manager Hierarchy',
  description: 'Org tree', targetType: 'Principal', parametersSchema: {},
};
vi.mock('../contexts/plugins/registry.js', () => ({
  REGISTERED_PLUGINS: [PLUGIN], getPlugin: (...a) => getPlugin(...a),
}));

const enqueueRun = vi.fn();
const dryRun = vi.fn();
const getRun = vi.fn();
const listRuns = vi.fn();
vi.mock('../contexts/plugins/runner.js', () => ({
  enqueueRun: (...a) => enqueueRun(...a),
  dryRun: (...a) => dryRun(...a),
  getRun: (...a) => getRun(...a),
  listRuns: (...a) => listRuns(...a),
}));

const getPrincipalColumns = vi.fn();
vi.mock('../db/columnCache.js', () => ({ getPrincipalColumns: (...a) => getPrincipalColumns(...a) }));

const { default: router } = await import('./contextPlugins.js');
const app = mountRouter(router);

const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  getPlugin.mockReset();
  enqueueRun.mockReset();
  dryRun.mockReset();
  getRun.mockReset();
  listRuns.mockReset();
  getPrincipalColumns.mockReset();
});

// ─── GET /context-plugins ────────────────────────────────────────────
describe('GET /context-plugins', () => {
  it('merges DB rows with in-process plugin metadata', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, name: 'manager-hierarchy', enabled: false }] });
    const res = await request(app).get('/api/context-plugins');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const p = res.body.data[0];
    expect(p).toMatchObject({ id: ID, name: 'manager-hierarchy', enabled: false, registered: true });
  });

  it('defaults enabled to true when no DB row exists', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/context-plugins');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ id: null, enabled: true });
  });

  it('500 when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/context-plugins');
    expect(res.status).toBe(500);
  });
});

// ─── GET /context-plugins/principal-attributes ───────────────────────
describe('GET /context-plugins/principal-attributes', () => {
  it('returns filtered columns + extended keys', async () => {
    getPrincipalColumns.mockResolvedValueOnce([
      { name: 'displayName' }, { name: 'id' }, { name: 'riskScore' }, { name: 'department' },
    ]);
    query.mockResolvedValueOnce({ rows: [{ k: 'sfDepartmentName' }, { k: 'extensionAttribute1' }] });
    const res = await request(app).get('/api/context-plugins/principal-attributes');
    expect(res.status).toBe(200);
    // Hidden columns (id, riskScore) are filtered out.
    expect(res.body.columns).toEqual(['displayName', 'department']);
    expect(res.body.extended).toEqual(['sfDepartmentName', 'extensionAttribute1']);
  });

  it('narrows extended keys by scopeSystemId', async () => {
    getPrincipalColumns.mockResolvedValueOnce([{ name: 'displayName' }]);
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/context-plugins/principal-attributes?scopeSystemId=5');
    expect(res.status).toBe(200);
    expect(query.mock.calls[0][1]).toEqual([5]);
  });

  it('returns empty arrays (200) when a query rejects', async () => {
    getPrincipalColumns.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/context-plugins/principal-attributes');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ columns: [], extended: [] });
  });
});

// ─── POST /context-plugins/:name/dry-run ─────────────────────────────
describe('POST /context-plugins/:name/dry-run', () => {
  it('404 when the plugin is unknown', async () => {
    getPlugin.mockReturnValue(null);
    const res = await request(app).post('/api/context-plugins/nope/dry-run').send({});
    expect(res.status).toBe(404);
  });

  it('returns the dry-run output', async () => {
    getPlugin.mockReturnValue(PLUGIN);
    dryRun.mockResolvedValueOnce({ contextCount: 3, memberCount: 9, samples: {} });
    const res = await request(app).post('/api/context-plugins/manager-hierarchy/dry-run').send({ scopeSystemId: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contextCount: 3, memberCount: 9 });
    expect(dryRun).toHaveBeenCalledWith('manager-hierarchy', { scopeSystemId: 1 });
  });

  it('400 when dryRun throws', async () => {
    getPlugin.mockReturnValue(PLUGIN);
    dryRun.mockRejectedValueOnce(new Error('bad params'));
    const res = await request(app).post('/api/context-plugins/manager-hierarchy/dry-run').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad params');
  });
});

// ─── POST /context-plugins/:name/run ─────────────────────────────────
describe('POST /context-plugins/:name/run', () => {
  it('404 when the plugin is unknown', async () => {
    getPlugin.mockReturnValue(null);
    const res = await request(app).post('/api/context-plugins/nope/run').send({});
    expect(res.status).toBe(404);
  });

  it('202 and returns the queued runId', async () => {
    getPlugin.mockReturnValue(PLUGIN);
    enqueueRun.mockResolvedValueOnce('run-1');
    const res = await request(app).post('/api/context-plugins/manager-hierarchy/run').send({ scopeSystemId: 2 });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: 'run-1', status: 'queued' });
  });

  it('400 when enqueueRun throws', async () => {
    getPlugin.mockReturnValue(PLUGIN);
    enqueueRun.mockRejectedValueOnce(new Error('missing param'));
    const res = await request(app).post('/api/context-plugins/manager-hierarchy/run').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing param');
  });
});

// ─── GET /context-plugins/runs ───────────────────────────────────────
describe('GET /context-plugins/runs', () => {
  it('returns the recent runs', async () => {
    listRuns.mockResolvedValueOnce([{ id: ID, status: 'succeeded' }]);
    const res = await request(app).get('/api/context-plugins/runs?limit=10');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: ID, status: 'succeeded' }], total: 1 });
  });

  it('500 when listRuns rejects', async () => {
    listRuns.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/context-plugins/runs');
    expect(res.status).toBe(500);
  });
});

// ─── GET /context-plugins/runs/:id ───────────────────────────────────
describe('GET /context-plugins/runs/:id', () => {
  it('400 on a malformed run id', async () => {
    const res = await request(app).get('/api/context-plugins/runs/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404 when the run is not found', async () => {
    getRun.mockResolvedValueOnce(null);
    const res = await request(app).get(`/api/context-plugins/runs/${ID}`);
    expect(res.status).toBe(404);
  });

  it('returns the run row', async () => {
    getRun.mockResolvedValueOnce({ id: ID, status: 'running' });
    const res = await request(app).get(`/api/context-plugins/runs/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ID, status: 'running' });
  });

  it('500 when getRun rejects', async () => {
    getRun.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/api/context-plugins/runs/${ID}`);
    expect(res.status).toBe(500);
  });
});

// ─── GET /context-plugins/trees ──────────────────────────────────────
describe('GET /context-plugins/trees', () => {
  it('maps tree rows with derived rootName + autoRefresh defaults', async () => {
    query.mockResolvedValueOnce({ rows: [
      { algorithmId: ID, algo: 'manager-hierarchy', algoDisplayName: 'Manager Hierarchy',
        targetType: 'Principal', scopeSystemId: 1, instanceKey: 'k1', contextCount: 4,
        params: { rootName: 'Org', autoRefresh: false }, lastStatus: 'succeeded',
        lastRunAt: '2026-01-01', lastRunBy: 'admin' },
      { algorithmId: ID, algo: 'resource-cluster', algoDisplayName: 'Clusters',
        targetType: 'Resource', scopeSystemId: null, instanceKey: null, contextCount: 2,
        params: null, lastStatus: null, lastRunAt: null, lastRunBy: null },
    ] });
    const res = await request(app).get('/api/context-plugins/trees');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ rootName: 'Org', autoRefresh: false, contextCount: 4 });
    // Null params → rootName falls back to algoDisplayName, autoRefresh defaults on.
    expect(res.body.data[1]).toMatchObject({ rootName: 'Clusters', autoRefresh: true, params: {} });
  });

  it('500 when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/context-plugins/trees');
    expect(res.status).toBe(500);
  });
});

// ─── DELETE /context-plugins/trees ───────────────────────────────────
describe('DELETE /context-plugins/trees', () => {
  it('400 when algorithmId is not a uuid', async () => {
    const res = await request(app).delete('/api/context-plugins/trees').send({ algorithmId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('deletes the tree and reports the row count', async () => {
    query.mockResolvedValueOnce({ rowCount: 7 });
    const res = await request(app).delete('/api/context-plugins/trees').send({ algorithmId: ID, instanceKey: 'k1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 7 });
  });

  it('500 when the DELETE rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).delete('/api/context-plugins/trees').send({ algorithmId: ID });
    expect(res.status).toBe(500);
  });
});
