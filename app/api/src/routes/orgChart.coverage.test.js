// Unit tests for routes/orgChart.js — manager / direct-reports / availability.
// DB mocked. UUID validation guards two of the three endpoints.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';

const { default: router } = await import('./orgChart.js');
const app = mountRouter(router);

const VALID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('GET /org-chart/user/:id/manager', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).get('/api/org-chart/user/nope/manager');
    expect(res.status).toBe(400);
  });

  it('returns the manager row', async () => {
    queryOne.mockResolvedValueOnce({ id: 'm1', displayName: 'Boss' });
    const res = await request(app).get(`/api/org-chart/user/${VALID}/manager`);
    expect(res.status).toBe(200);
    expect(res.body.manager).toMatchObject({ id: 'm1' });
  });

  it('returns null manager when none', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).get(`/api/org-chart/user/${VALID}/manager`);
    expect(res.status).toBe(200);
    expect(res.body.manager).toBeNull();
  });

  it('500 when query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('db'));
    const res = await request(app).get(`/api/org-chart/user/${VALID}/manager`);
    expect(res.status).toBe(500);
  });
});

describe('GET /org-chart/user/:id/reports', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).get('/api/org-chart/user/nope/reports');
    expect(res.status).toBe(400);
  });

  it('returns reports with totalCount', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] });
    const res = await request(app).get(`/api/org-chart/user/${VALID}/reports`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalCount: 2 });
    expect(res.body.reports).toHaveLength(2);
  });

  it('500 when query rejects', async () => {
    query.mockRejectedValueOnce(new Error('db'));
    const res = await request(app).get(`/api/org-chart/user/${VALID}/reports`);
    expect(res.status).toBe(500);
  });
});

// Soft delete (migration 040): a removed manager / report keeps its Principals
// row. The mock is SQL-blind, so these pin what the handler asks for; the rows
// themselves are checked in contract-tests/identityAndPeopleHistory.contract.test.js.
describe('org-chart — soft-deleted manager and reports are flagged, not hidden', () => {
  it('the manager carries deleted + deletedAt', async () => {
    queryOne.mockResolvedValueOnce({ id: 'm1', deleted: true, deletedAt: '2026-09-01T00:00:00Z' });
    const res = await request(app).get(`/api/org-chart/user/${VALID}/manager`);
    expect(res.body.manager).toMatchObject({ deleted: true, deletedAt: '2026-09-01T00:00:00Z' });
    const [sql] = queryOne.mock.calls[0];
    expect(sql).toContain('(m."deletedAt" IS NOT NULL) AS "deleted", m."deletedAt"');
    expect(sql).not.toMatch(/m\."deletedAt" IS NULL/); // flagged, not filtered out
  });

  it('reports carry deleted + deletedAt, current ones first', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'a', deleted: false }, { id: 'b', deleted: true }] });
    const res = await request(app).get(`/api/org-chart/user/${VALID}/reports`);
    expect(res.body.reports.map((r) => r.deleted)).toEqual([false, true]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('(r."deletedAt" IS NOT NULL) AS "deleted", r."deletedAt"');
    expect(sql).toContain('ORDER BY "deleted", r."displayName"');
    expect(params).toEqual([VALID, 200]);
  });
});

describe('GET /org-chart (availability)', () => {
  it('available true when manager-hierarchy contexts exist', async () => {
    queryOne.mockResolvedValueOnce({ n: 4 });
    const res = await request(app).get('/api/org-chart');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true });
  });

  // "Produced by the manager-hierarchy plugin" is a property of the source
  // algorithm, not of the nodes' contextType (a template choice).
  it('counts generated contexts by their source algorithm, not by contextType', async () => {
    queryOne.mockResolvedValueOnce({ n: 1 });
    await request(app).get('/api/org-chart');
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain('JOIN "ContextAlgorithms" a ON c."sourceAlgorithmId" = a.id');
    expect(sql).toContain('a.name    = $1');
    expect(sql).toContain(`c.variant = 'generated'`);
    expect(sql).not.toContain('contextType');
    expect(params).toEqual(['manager-hierarchy']);
  });

  it('available false when none', async () => {
    queryOne.mockResolvedValueOnce({ n: 0 });
    const res = await request(app).get('/api/org-chart');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false });
  });

  it('available false (swallowed) when query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('db'));
    const res = await request(app).get('/api/org-chart');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false });
  });
});
