// Coverage tests for routes/categories.js — happy paths (create/update/delete/
// assign/unassign), conflict (409), not-found shaping, access-packages list, and
// error (500) paths. DB mocked. Cases here deliberately do NOT overlap with
// categories.test.js (which covers validation 400s).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

let nextResult = { recordset: [] };
const mockPool = {
  request() {
    const r = { input() { return r; }, query: (...a) => poolQuery(...a) };
    return r;
  },
};
const poolQuery = vi.fn(async () => nextResult);
const query = vi.fn();
const queryOne = vi.fn();
const tx = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => mockPool,
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
  tx: (...a) => tx(...a),
}));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));

const { default: router } = await import('./categories.js');
const app = mountRouter(router);

const RES = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  nextResult = { recordset: [] };
  poolQuery.mockReset();
  poolQuery.mockImplementation(async () => nextResult);
  query.mockReset();
  queryOne.mockReset();
  tx.mockReset();
  tx.mockImplementation(async (fn) => fn({ query: (...a) => query(...a) }));
});

describe('GET /categories', () => {
  it('200 returns rows', async () => {
    nextResult = { recordset: [{ id: 1, name: 'Finance', color: '#3b82f6', assignmentCount: 2 }] };
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('500 when the query rejects', async () => {
    poolQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(500);
  });
});

// The other consumer of the shared fetchCategoryRows helper. Unlike
// GET /categories it degrades to an empty array on error rather than a 500.
describe('GET /category-assignments', () => {
  it('200 returns the flat assignment list', async () => {
    nextResult = { recordset: [{ resourceId: RES, businessRoleId: RES, categoryId: 2, categoryName: 'Finance', categoryColor: '#3b82f6' }] };
    const res = await request(app).get('/api/category-assignments');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ categoryId: 2, categoryName: 'Finance' });
  });

  it('returns [] when the query rejects (defensive)', async () => {
    poolQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/category-assignments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /categories', () => {
  it('201 creates a category (default color)', async () => {
    nextResult = { recordset: [{ id: 5, name: 'HR', color: '#3b82f6' }] };
    const res = await request(app).post('/api/categories').send({ name: 'HR' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 5, name: 'HR' });
  });

  it('409 on a unique-constraint violation', async () => {
    poolQuery.mockRejectedValueOnce(new Error('duplicate key value violates UNIQUE constraint'));
    const res = await request(app).post('/api/categories').send({ name: 'Dup' });
    expect(res.status).toBe(409);
  });

  it('500 on an unexpected insert error', async () => {
    poolQuery.mockRejectedValueOnce(new Error('disk full'));
    const res = await request(app).post('/api/categories').send({ name: 'X', color: '#10b981' });
    expect(res.status).toBe(500);
  });
});

describe('PATCH /categories/:id', () => {
  it('200 updates name + color', async () => {
    nextResult = { recordset: [{ id: 3, name: 'New', color: '#ef4444' }] };
    const res = await request(app).patch('/api/categories/3').send({ name: 'New', color: '#ef4444' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 3, name: 'New' });
  });

  it('400 when nothing to update', async () => {
    const res = await request(app).patch('/api/categories/3').send({});
    expect(res.status).toBe(400);
  });

  it('200 null when the row does not exist', async () => {
    nextResult = { recordset: [] };
    const res = await request(app).patch('/api/categories/9').send({ name: 'Ghost' });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('500 when the update rejects', async () => {
    poolQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).patch('/api/categories/3').send({ name: 'New' });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /categories/:id', () => {
  it('200 deletes the category', async () => {
    const res = await request(app).delete('/api/categories/3');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('500 when the delete rejects', async () => {
    poolQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).delete('/api/categories/3');
    expect(res.status).toBe(500);
  });
});

describe('POST /categories/:id/assign', () => {
  it('200 replaces the assignment in a transaction', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    const res = await request(app).post('/api/categories/2/assign').send({ resourceId: RES });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(tx).toHaveBeenCalled();
  });

  it('200 accepts the legacy businessRoleId field', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    const res = await request(app).post('/api/categories/2/assign').send({ businessRoleId: RES });
    expect(res.status).toBe(200);
  });

  it('400 on a non-integer category id', async () => {
    const res = await request(app).post('/api/categories/abc/assign').send({ resourceId: RES });
    expect(res.status).toBe(400);
  });

  it('500 when the transaction rejects', async () => {
    tx.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/categories/2/assign').send({ resourceId: RES });
    expect(res.status).toBe(500);
  });
});

describe('POST /categories/unassign', () => {
  it('200 removes the assignment', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app).post('/api/categories/unassign').send({ resourceId: RES });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('400 when resourceId is missing', async () => {
    const res = await request(app).post('/api/categories/unassign').send({});
    expect(res.status).toBe(400);
  });

  it('500 when the delete rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/categories/unassign').send({ businessRoleId: RES });
    expect(res.status).toBe(500);
  });
});

describe('GET /access-packages', () => {
  it('200 lists access packages (no review table) and derives assignmentType', async () => {
    queryOne.mockResolvedValueOnce({ t: null }); // CertificationDecisions absent
    query
      .mockResolvedValueOnce({
        rows: [{
          id: RES, displayName: 'AP1', description: 'd',
          catalogName: 'Cat', catalogId: 1, totalAssignments: 5,
          categoryId: 2, categoryName: 'Finance', categoryColor: '#3b82f6',
          policyCount: 1, autoAddCount: 1, autoRemoveOnlyCount: 0,
          hasReviewConfigured: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const res = await request(app).get('/api/access-packages?search=ap&categoryId=2&sortCol=category&sortDir=desc');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ id: RES, assignmentType: 'Auto-assigned', category: { id: 2, name: 'Finance' } });
  });

  it('200 with review table present + uncategorized filter', async () => {
    queryOne.mockResolvedValueOnce({ t: 'CertificationDecisions' });
    query
      .mockResolvedValueOnce({
        rows: [{
          id: RES, displayName: 'AP2', description: null,
          catalogName: null, catalogId: null, totalAssignments: 0,
          categoryId: null, categoryName: null, categoryColor: null,
          policyCount: 0, autoAddCount: 0, autoRemoveOnlyCount: 0,
          hasReviewConfigured: false,
          complianceStatus: 'In Progress', daysOverdue: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const res = await request(app).get('/api/access-packages?uncategorized=true');
    expect(res.status).toBe(200);
    // totalAssignments=0 + In Progress => complianceStatus suppressed to null
    expect(res.body.data[0].complianceStatus).toBeNull();
    expect(res.body.data[0].category).toBeNull();
  });

  it('200 derives Request-based assignmentType', async () => {
    queryOne.mockResolvedValueOnce({ t: null });
    query
      .mockResolvedValueOnce({
        rows: [{
          id: RES, displayName: 'AP3', totalAssignments: 1,
          policyCount: 2, autoAddCount: 0, autoRemoveOnlyCount: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const res = await request(app).get('/api/access-packages');
    expect(res.status).toBe(200);
    expect(res.body.data[0].assignmentType).toBe('Request-based');
  });

  it('500 when the data query rejects', async () => {
    queryOne.mockResolvedValueOnce({ t: null });
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/access-packages');
    expect(res.status).toBe(500);
  });
});

describe('GET /category-assignments', () => {
  it('200 returns the flat assignment list', async () => {
    nextResult = { recordset: [{ resourceId: RES, businessRoleId: RES, categoryId: 1, categoryName: 'Finance', categoryColor: '#3b82f6' }] };
    const res = await request(app).get('/api/category-assignments');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('200 returns [] on error (graceful)', async () => {
    poolQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/category-assignments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
