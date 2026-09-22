// Unit tests for routes/matrix/savedFilters.js — CRUD validation. DB mocked.
// UUID_RE comes from the real filterSql.js (a pure regex — not mocked).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
const { query, queryOne } = await import('../../db/connection.js');

const { default: router } = await import('./savedFilters.js');
const app = mountRouter(router);

const VALID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('matrix saved-filters', () => {
  it('GET /matrix/saved-filters returns the rows with their shared state', async () => {
    // Blanket-mock db.query so the handler's SELECT returns rows (the table is
    // created by migrations 023/028 now, not a runtime ensure step).
    const rows = [{ id: VALID, name: 'Mine', shared: true, recipientCount: 2 }];
    query.mockResolvedValue({ rows });
    const res = await request(app).get('/api/matrix/saved-filters');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);

    const sql = query.mock.calls[0][0];
    // Shared state comes from a LIVE share only — a revoked one must not make a
    // saved matrix read as still shared (#1202).
    expect(sql).toMatch(/"savedFilterId" = f\.id AND s\."revokedAt" IS NULL/);
    expect(sql).toMatch(/AS "recipientCount"/);
    // Counts only: who it is shared with is data.share information.
    expect(sql).not.toMatch(/"displayName"/);
  });

  it('POST 400 when name is missing', async () => {
    expect((await request(app).post('/api/matrix/saved-filters').send({ filter: {} })).status).toBe(400);
  });

  it('POST 400 when filter is missing/not an object', async () => {
    expect((await request(app).post('/api/matrix/saved-filters').send({ name: 'X' })).status).toBe(400);
  });

  it('PUT 400 on a malformed id', async () => {
    expect((await request(app).put('/api/matrix/saved-filters/nope').send({ name: 'X' })).status).toBe(400);
  });

  it('PUT 400 when there are no updatable fields', async () => {
    expect((await request(app).put(`/api/matrix/saved-filters/${VALID}`).send({})).status).toBe(400);
  });

  it('DELETE 400 on a malformed id', async () => {
    expect((await request(app).delete('/api/matrix/saved-filters/nope')).status).toBe(400);
  });

  it('POST 201 creates a filter and returns the stored row', async () => {
    query.mockResolvedValue({});                                   // INSERT
    queryOne.mockResolvedValue({ id: VALID, name: 'New', filter: {} }); // SELECT back
    const res = await request(app).post('/api/matrix/saved-filters').send({ name: 'New', filter: { rowType: 'user' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: VALID, name: 'New', filter: {} });
  });

  // The UI tags an applied matrix with the saved matrix it came from (#1202).
  // Saving that view as a new matrix must not store the tag, or the copy would
  // claim to be the original it was loaded from.
  it('POST stores the filter without the loaded-from tag', async () => {
    query.mockResolvedValue({});
    queryOne.mockResolvedValue({ id: VALID, name: 'Copy', filter: {} });
    await request(app).post('/api/matrix/saved-filters')
      .send({ name: 'Copy', filter: { rowType: 'identity', managed: 'gaps', savedFilterId: 'orig-id' } });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO "SavedMatrixFilters"'));
    expect(insert[1][3]).toEqual({ rowType: 'identity', managed: 'gaps' });
  });

  it('PUT stores the filter without the loaded-from tag', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: VALID }] });
    await request(app).put(`/api/matrix/saved-filters/${VALID}`)
      .send({ filter: { rowType: 'principal', savedFilterId: VALID } });
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE'));
    expect(update[1][0]).toEqual({ rowType: 'principal' });
  });

  it('POST 409 on a duplicate name', async () => {
    query.mockRejectedValue({ code: '23505' });
    const res = await request(app).post('/api/matrix/saved-filters').send({ name: 'Dup', filter: {} });
    expect(res.status).toBe(409);
  });

  it('PUT 200 updates a filter', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: VALID, name: 'Renamed', isDefault: true }] });
    const res = await request(app).put(`/api/matrix/saved-filters/${VALID}`)
      .send({ name: 'Renamed', description: null, filter: { rowType: 'group' }, isDefault: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: VALID, name: 'Renamed', isDefault: true });
  });

  it('PUT 404 when the filter does not exist', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(app).put(`/api/matrix/saved-filters/${VALID}`).send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE 204 removes a filter, revoking its share first (#1202)', async () => {
    // Inside db.tx: call 0 revokes any live share of this matrix, call 1 deletes
    // it. Staged with DIFFERENT rowCounts so a handler that read the revoke's
    // result as the delete's would report 404 for a successful delete.
    query
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 });
    expect((await request(app).delete(`/api/matrix/saved-filters/${VALID}`)).status).toBe(204);

    const [revokeSql, revokeParams] = query.mock.calls[0];
    expect(revokeSql).toMatch(/UPDATE "MatrixShares"/);
    expect(revokeSql).toMatch(/"savedFilterId" = \$1 AND "revokedAt" IS NULL/);
    expect(revokeParams[0]).toBe(VALID);
    // Soft revoke — the usage history Admin reports on must survive the delete.
    expect(revokeSql).not.toMatch(/DELETE FROM "MatrixShares"/);
    expect(query.mock.calls[1][0]).toMatch(/DELETE FROM "SavedMatrixFilters"/);
  });

  it('DELETE 404 when the filter does not exist', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rowCount: 0 });
    expect((await request(app).delete(`/api/matrix/saved-filters/${VALID}`)).status).toBe(404);
  });

  it('GET /matrix/default-filter returns the default row', async () => {
    queryOne.mockResolvedValue({ id: VALID, name: 'Default', isDefault: true });
    const res = await request(app).get('/api/matrix/default-filter');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: VALID, name: 'Default', isDefault: true });
  });
});

describe('matrix saved-filter history', () => {
  const ROW = {
    id: VALID, name: 'Sales', createdBy: 'wim@example.com', createdAt: '2026-03-01T10:00:00Z',
    updatedBy: 'anna@example.com', updatedAt: '2026-09-20T10:00:00Z',
  };

  it('400 on a malformed id, without touching the database', async () => {
    expect((await request(app).get('/api/matrix/saved-filters/nope/history')).status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('404 for a matrix that does not exist, without reading history for it', async () => {
    queryOne.mockResolvedValue(null);
    expect((await request(app).get(`/api/matrix/saved-filters/${VALID}/history`)).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the row attribution with the trail built from its own history rows', async () => {
    queryOne.mockResolvedValue(ROW);
    query.mockResolvedValue({ rows: [
      { operation: 'U', changedAt: '2026-09-20T10:00:00Z', prevData: { name: 'Sales' }, rowData: { name: 'Sales EMEA', updatedBy: 'anna@example.com' } },
      // A re-save that only re-stamped the writer: recorded, but not an event.
      { operation: 'U', changedAt: '2026-09-15T10:00:00Z', prevData: { name: 'Sales', updatedBy: 'wim@example.com' }, rowData: { name: 'Sales', updatedBy: 'anna@example.com' } },
      { operation: 'I', changedAt: '2026-03-01T10:00:00Z', rowData: { name: 'Sales', createdBy: 'wim@example.com' } },
    ] });

    const res = await request(app).get(`/api/matrix/saved-filters/${VALID}/history`);
    expect(res.status).toBe(200);
    expect(res.body.createdBy).toBe('wim@example.com');
    expect(res.body.events).toEqual([
      {
        at: '2026-09-20T10:00:00Z', actor: 'anna@example.com', operation: 'changed',
        changes: [{ field: 'name', label: 'Name', from: 'Sales', to: 'Sales EMEA' }],
      },
      { at: '2026-03-01T10:00:00Z', actor: 'wim@example.com', operation: 'created', changes: [] },
    ]);

    const [sql, params] = query.mock.calls[0];
    // Scoped to THIS matrix in THIS table — an unscoped read would hand one
    // matrix's trail the renames of every other tracked entity.
    expect(sql).toMatch(/"tableName" = 'SavedMatrixFilters'/);
    expect(sql).toMatch(/"rowId" = \$1/);
    expect(sql).toMatch(/ORDER BY "changedAt" DESC/);
    expect(params).toEqual([VALID]);
  });

  it('reports a matrix with no recorded changes as an empty trail, not as an error', async () => {
    queryOne.mockResolvedValue(ROW);
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get(`/api/matrix/saved-filters/${VALID}/history`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.createdBy).toBe('wim@example.com');
  });

  it('500 when the history read fails', async () => {
    queryOne.mockResolvedValue(ROW);
    query.mockRejectedValue(new Error('boom'));
    expect((await request(app).get(`/api/matrix/saved-filters/${VALID}/history`)).status).toBe(500);
  });
});
