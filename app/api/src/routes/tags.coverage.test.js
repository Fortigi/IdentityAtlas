// Coverage tests for routes/tags.js — happy paths (create/update/delete/assign/
// unassign/assign-by-filter), not-found (404), duplicate (409), and error (500)
// paths. DB + column-cache / bootstrap / memberCounts helpers mocked. Cases here
// deliberately do NOT overlap with tags.test.js (which covers validation 400s).

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
vi.mock('../db/connection.js', () => ({
  getPool: async () => mockPool,
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
}));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('../db/columnCache.js', () => ({
  getGroupColumns: vi.fn(async () => []), getResourceColumns: vi.fn(async () => []),
  getPrincipalOrUserColumns: vi.fn(async () => []), getPrincipalOrUserColumnValues: vi.fn(async () => ({})),
  getGroupColumnValues: vi.fn(async () => ({})), getResourceColumnValues: vi.fn(async () => ({})),
}));
vi.mock('../bootstrap.js', () => ({ getOrCreateTagRoot: vi.fn(async () => 'root-id') }));
vi.mock('../contexts/memberCounts.js', () => ({ recalcMemberCountsForChain: vi.fn(async () => {}) }));

const { default: router } = await import('./tags.js');
const app = mountRouter(router);

const VALID = '11111111-1111-1111-1111-111111111111';
const VALID2 = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  nextResult = { recordset: [] };
  poolQuery.mockReset();
  poolQuery.mockImplementation(async () => nextResult);
  query.mockReset();
  queryOne.mockReset();
});

describe('GET /tags', () => {
  it('filters by entityType and returns rows', async () => {
    nextResult = { recordset: [{ id: VALID, name: 'PII', color: '#3b82f6', entityType: 'user' }] };
    const res = await request(app).get('/api/tags?entityType=user');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('500 when the pool query rejects', async () => {
    poolQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/tags');
    expect(res.status).toBe(500);
  });
});

describe('POST /tags', () => {
  it('201 creates a tag and returns the shaped row', async () => {
    queryOne.mockResolvedValueOnce(null); // no duplicate
    query.mockResolvedValueOnce({
      rows: [{
        id: VALID, displayName: 'PII', targetType: 'Principal',
        extendedAttributes: { tagColor: '#10b981' },
        createdAt: '2026-01-01', updatedAt: '2026-01-02',
      }],
    });
    const res = await request(app).post('/api/tags').send({ name: 'PII', entityType: 'user', color: '#10b981' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: VALID, name: 'PII', color: '#10b981', entityType: 'user', assignmentCount: 0 });
  });

  it('409 when a tag of the same name/type already exists', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID });
    const res = await request(app).post('/api/tags').send({ name: 'PII', entityType: 'resource' });
    expect(res.status).toBe(409);
  });

  it('500 when the insert rejects', async () => {
    queryOne.mockResolvedValueOnce(null);
    query.mockRejectedValueOnce(new Error('insert failed'));
    const res = await request(app).post('/api/tags').send({ name: 'PII', entityType: 'identity' });
    expect(res.status).toBe(500);
  });
});

describe('PATCH /tags/:id', () => {
  it('200 updates name + color', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, extendedAttributes: { tagColor: '#3b82f6' } });
    query.mockResolvedValueOnce({ rows: [{ id: VALID, displayName: 'New', targetType: 'Resource', extendedAttributes: { tagColor: '#ef4444' } }] });
    const res = await request(app).patch(`/api/tags/${VALID}`).send({ name: 'New', color: '#ef4444' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'New', color: '#ef4444' });
  });

  it('404 when the tag does not exist', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).patch(`/api/tags/${VALID}`).send({ name: 'New' });
    expect(res.status).toBe(404);
  });

  it('400 when there is nothing to update', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, extendedAttributes: {} });
    const res = await request(app).patch(`/api/tags/${VALID}`).send({});
    expect(res.status).toBe(400);
  });

  it('400 on a non-hex color', async () => {
    const res = await request(app).patch(`/api/tags/${VALID}`).send({ color: 'red' });
    expect(res.status).toBe(400);
  });

  it('500 when the lookup rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).patch(`/api/tags/${VALID}`).send({ name: 'New' });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /tags/:id', () => {
  it('200 deletes the tag', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app).delete(`/api/tags/${VALID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('400 on a malformed id', async () => {
    const res = await request(app).delete('/api/tags/nope');
    expect(res.status).toBe(400);
  });

  it('500 when the delete rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).delete(`/api/tags/${VALID}`);
    expect(res.status).toBe(500);
  });
});

describe('POST /tags/:id/assign', () => {
  it('200 inserts members', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Principal' });
    query.mockResolvedValueOnce({ rowCount: 2 });
    const res = await request(app).post(`/api/tags/${VALID}/assign`).send({ entityIds: [VALID, VALID2] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 2 });
  });

  it('404 when the tag does not exist', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).post(`/api/tags/${VALID}/assign`).send({ entityIds: [VALID] });
    expect(res.status).toBe(404);
  });

  it('200 inserted:0 when no entityIds are valid UUIDs', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Principal' });
    const res = await request(app).post(`/api/tags/${VALID}/assign`).send({ entityIds: ['not-a-uuid'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 0 });
  });

  it('400 when more than 500 entityIds', async () => {
    const ids = Array.from({ length: 501 }, () => VALID);
    const res = await request(app).post(`/api/tags/${VALID}/assign`).send({ entityIds: ids });
    expect(res.status).toBe(400);
  });

  it('500 when the lookup rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post(`/api/tags/${VALID}/assign`).send({ entityIds: [VALID] });
    expect(res.status).toBe(500);
  });
});

describe('POST /tags/:id/unassign', () => {
  it('200 deletes members', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app).post(`/api/tags/${VALID}/unassign`).send({ entityIds: [VALID] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 1 });
  });

  it('400 on a malformed id', async () => {
    const res = await request(app).post('/api/tags/nope/unassign').send({ entityIds: [VALID] });
    expect(res.status).toBe(400);
  });

  it('400 when entityIds is empty', async () => {
    const res = await request(app).post(`/api/tags/${VALID}/unassign`).send({ entityIds: [] });
    expect(res.status).toBe(400);
  });

  it('200 deleted:0 when no valid UUIDs', async () => {
    const res = await request(app).post(`/api/tags/${VALID}/unassign`).send({ entityIds: ['nope'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it('500 when the delete rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post(`/api/tags/${VALID}/unassign`).send({ entityIds: [VALID] });
    expect(res.status).toBe(500);
  });
});

describe('POST /tags/:id/assign-by-filter', () => {
  it('400 when entityType is missing', async () => {
    const res = await request(app).post(`/api/tags/${VALID}/assign-by-filter`).send({});
    expect(res.status).toBe(400);
  });

  it('400 on a malformed tag id', async () => {
    const res = await request(app).post('/api/tags/nope/assign-by-filter').send({ entityType: 'user' });
    expect(res.status).toBe(400);
  });

  it('404 when the tag does not exist', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).post(`/api/tags/${VALID}/assign-by-filter`).send({ entityType: 'resource' });
    expect(res.status).toBe(404);
  });

  it('200 inserts matched entities (user + search + filters)', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Principal' });
    // Pool queries: 1) to_regclass Principals check, 2) the INSERT
    poolQuery
      .mockResolvedValueOnce({ recordset: [{ principalsExists: 'Principals' }] })
      .mockResolvedValueOnce({ rowsAffected: [3] });
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'user', search: 'alice', filters: { department: 'IT' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 3 });
  });

  it('200 for resource entityType with search', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Resource' });
    poolQuery.mockResolvedValueOnce({ rowsAffected: [1] });
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'resource', search: 'grp' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 1 });
  });

  it('200 for identity entityType', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Identity' });
    poolQuery.mockResolvedValueOnce({ rowsAffected: [0] });
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'identity', search: 'bob' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 0 });
  });

  it('500 when the lookup rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'user' });
    expect(res.status).toBe(500);
  });
});

describe('GET /user-columns-page', () => {
  it('200 returns columns with a __userTag virtual column', async () => {
    nextResult = { recordset: [{ name: 'Confidential' }] };
    const res = await request(app).get('/api/user-columns-page');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /group-columns', () => {
  it('200 returns columns (Resources path)', async () => {
    // Column values come from the mocked columnCache; the only pool query here
    // is the __groupTag tag-name lookup (the v4 GraphGroups existence probe is gone).
    poolQuery.mockResolvedValue({ recordset: [] });
    const res = await request(app).get('/api/group-columns');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Regression guard (#662): the removed existence probe was
    // `SELECT TOP 0 * FROM Resources` — T-SQL that always threw on Postgres and
    // wasted a round-trip on every request. The handler must not emit it.
    const sqls = poolQuery.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /\bTOP\s+0\b/i.test(s))).toBe(false);
  });

  it('200 schema=true fast path', async () => {
    poolQuery.mockResolvedValue({ recordset: [] });
    const res = await request(app).get('/api/resource-columns-page?schema=true');
    expect(res.status).toBe(200);
  });
});

describe('GET /users', () => {
  it('200 returns paginated data shaped with tags', async () => {
    nextResult = {
      recordsets: [
        [{ id: VALID, displayName: 'Alice', tagString: `${VALID}:PII:#3b82f6`, extendedAttributes: { a: 1 } }],
        [{ total: 1 }],
      ],
    };
    const res = await request(app).get('/api/users?search=al&tagId=' + VALID);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].tags).toEqual([{ id: VALID, name: 'PII', color: '#3b82f6' }]);
  });

  it('200 honours __userTag filter and string extendedAttributes', async () => {
    nextResult = {
      recordsets: [
        [{ id: VALID, displayName: 'Bob', tagString: null, extendedAttributes: '{"x":2}' }],
        [{ total: 1 }],
      ],
    };
    const filters = encodeURIComponent(JSON.stringify({ __userTag: 'PII', department: 'IT' }));
    const res = await request(app).get(`/api/users?filters=${filters}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].extendedAttributes).toEqual({ x: 2 });
  });

  it('500 when the query rejects', async () => {
    poolQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(500);
  });
});

describe('GET /groups', () => {
  it('200 returns paginated data with tag + resourceType filters', async () => {
    nextResult = {
      recordsets: [
        [{ id: VALID, displayName: 'Grp', tagString: null }],
        [{ total: 1 }],
      ],
    };
    const filters = encodeURIComponent(JSON.stringify({ __groupTag: 'Sensitive' }));
    const res = await request(app).get(`/api/groups?search=g&tagId=${VALID}&resourceType=Group&filters=${filters}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('200 accepts __resourceTag filter alias', async () => {
    nextResult = { recordsets: [[], [{ total: 0 }]] };
    const filters = encodeURIComponent(JSON.stringify({ __resourceTag: 'Sensitive' }));
    const res = await request(app).get(`/api/groups?filters=${filters}`);
    expect(res.status).toBe(200);
  });

  it('500 when the query rejects', async () => {
    poolQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/groups');
    expect(res.status).toBe(500);
  });
});

describe('GET /entity-tags', () => {
  it('200 returns the assignment list', async () => {
    nextResult = { recordset: [{ entityId: VALID, tagId: VALID, tagName: 'PII', tagColor: '#3b82f6' }] };
    const res = await request(app).get('/api/entity-tags?entityType=user');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('400 when entityType is missing', async () => {
    const res = await request(app).get('/api/entity-tags');
    expect(res.status).toBe(400);
  });
});
