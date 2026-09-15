// Coverage tests for routes/tags.js — happy paths (create/update/delete/assign/
// unassign/assign-by-filter), not-found (404), duplicate (409), and error (500)
// paths. DB + column-cache / bootstrap / memberCounts helpers mocked. Cases here
// deliberately do NOT overlap with tags.test.js (which covers validation 400s).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

// All tag handlers use native db.query / db.queryOne now (#663 removed the shim).
// getPool() is only handed to the mocked ensureTagTables / column-cache helpers.
vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';
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
  query.mockReset();
  queryOne.mockReset();
});

describe('GET /tags', () => {
  it('filters by entityType and returns rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: VALID, name: 'PII', color: '#3b82f6', entityType: 'user' }] });
    const res = await request(app).get('/api/tags?entityType=user');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('500 when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
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

describe('POST /tags — inherited property names are not entity types (SEC-2026-09 L-15)', () => {
  for (const entityType of ['constructor', 'toString', '__proto__']) {
    it(`400 for entityType=${entityType}, nothing queried`, async () => {
      queryOne.mockReset();
      query.mockReset();
      const res = await request(app).post('/api/tags').send({ name: 'PII', entityType });
      expect(res.status).toBe(400);
      expect(queryOne).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });
  }
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
    // The INSERT … SELECT reports pg's rowCount (v5 always uses Principals — no table probe).
    query.mockResolvedValueOnce({ rowCount: 3 });
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'user', search: 'alice', filters: { department: 'IT' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 3 });
  });

  it('200 for resource entityType with search', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Resource' });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'resource', search: 'grp', filters: { resourceType: 'Group' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 1 });
  });

  it('200 for identity entityType', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Identity' });
    query.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'identity', search: 'bob', filters: { department: 'X' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inserted: 0 });
  });

  it('applies the __system filter so bulk-tag cannot over-tag other systems', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Principal' });
    query.mockResolvedValueOnce({ rowCount: 2 });
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'user', filters: { __system: 'Contoso HR' } });
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/EXISTS \(SELECT 1 FROM "Systems" _sys WHERE _sys\.id = e\."systemId"/);
    expect(params).toContain('Contoso HR');
  });

  it('drops the __system filter for identities, which have no systemId column', async () => {
    queryOne.mockResolvedValueOnce({ id: VALID, targetType: 'Identity' });
    query.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(app)
      .post(`/api/tags/${VALID}/assign-by-filter`)
      .send({ entityType: 'identity', filters: { __system: 'Contoso HR' } });
    expect(res.status).toBe(200);
    expect(String(query.mock.calls[0][0])).not.toContain('"Systems" _sys');
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
  it('200 returns columns with the __userTag and __system virtual columns', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ name: 'Confidential' }] })      // tag names
      .mockResolvedValueOnce({ rows: [{ displayName: 'Contoso HR' }] }); // system names
    const res = await request(app).get('/api/user-columns-page');
    expect(res.status).toBe(200);
    expect(res.body.find(c => c.column === '__userTag').values).toEqual(['Confidential']);
    expect(res.body.find(c => c.column === '__system').values).toEqual(['Contoso HR']);
  });
});

describe('GET /group-columns', () => {
  it('200 returns columns (Resources path) incl. the __system virtual column', async () => {
    // Column values come from the mocked columnCache; the db queries here are
    // the __groupTag tag-name lookup (the v4 GraphGroups existence probe is
    // gone) and the __system display-name lookup.
    query.mockResolvedValue({ rows: [{ displayName: 'Contoso HR' }] });
    const res = await request(app).get('/api/group-columns');
    expect(res.status).toBe(200);
    expect(res.body.find(c => c.column === '__system').values).toEqual(['Contoso HR']);
    // Regression guard (#662): the removed existence probe was
    // `SELECT TOP 0 * FROM Resources` — T-SQL that always threw on Postgres and
    // wasted a round-trip on every request. The handler must not emit it.
    const sqls = query.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /\bTOP\s+0\b/i.test(s))).toBe(false);
  });

  it('200 schema=true fast path — virtual columns present, no values fetched', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/resource-columns-page?schema=true');
    expect(res.status).toBe(200);
    expect(res.body.find(c => c.column === '__system').values).toEqual([]);
    // The values lookup is skipped on this path, so only the tag query ran.
    expect(query.mock.calls.some(c => /FROM "Systems"/.test(String(c[0])))).toBe(false);
  });
});

describe('GET /users', () => {
  it('200 returns paginated data shaped with tags', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: VALID, displayName: 'Alice', tagString: `${VALID}:PII:#3b82f6`, extendedAttributes: { a: 1 } }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const res = await request(app).get('/api/users?search=al&tagId=' + VALID);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].tags).toEqual([{ id: VALID, name: 'PII', color: '#3b82f6' }]);
  });

  it('200 honours __userTag filter and string extendedAttributes', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: VALID, displayName: 'Bob', tagString: null, extendedAttributes: '{"x":2}' }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const filters = encodeURIComponent(JSON.stringify({ __userTag: 'PII', department: 'IT' }));
    const res = await request(app).get(`/api/users?filters=${filters}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].extendedAttributes).toEqual({ x: 2 });
  });

  it('200 translates a __system filter into a bound Systems predicate', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    const filters = encodeURIComponent(JSON.stringify({ __system: 'Contoso HR' }));
    const res = await request(app).get(`/api/users?filters=${filters}`);
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/EXISTS \(SELECT 1 FROM "Systems" _sys WHERE _sys\.id = u\."systemId"/);
    expect(params).toContain('Contoso HR');
    // Never emitted as a raw column match — `__system` is not a Principals column.
    expect(String(sql)).not.toMatch(/u\."__system"/);
  });

  it('500 when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(500);
  });
});

describe('GET /groups', () => {
  it('200 returns paginated data with tag + resourceType filters', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: VALID, displayName: 'Grp', tagString: null }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const filters = encodeURIComponent(JSON.stringify({ __groupTag: 'Sensitive' }));
    const res = await request(app).get(`/api/groups?search=g&tagId=${VALID}&resourceType=Group&filters=${filters}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('200 accepts __resourceTag filter alias', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    const filters = encodeURIComponent(JSON.stringify({ __resourceTag: 'Sensitive' }));
    const res = await request(app).get(`/api/groups?filters=${filters}`);
    expect(res.status).toBe(200);
  });

  it('200 translates a __system filter into a bound Systems predicate', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    const filters = encodeURIComponent(JSON.stringify({ __system: 'Contoso HR' }));
    const res = await request(app).get(`/api/groups?filters=${filters}`);
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/EXISTS \(SELECT 1 FROM "Systems" _sys WHERE _sys\.id = r\."systemId"/);
    expect(params).toContain('Contoso HR');
  });

  it('500 when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/groups');
    expect(res.status).toBe(500);
  });
});

describe('GET /entity-tags', () => {
  it('200 returns the assignment list', async () => {
    query.mockResolvedValueOnce({ rows: [{ entityId: VALID, tagId: VALID, tagName: 'PII', tagColor: '#3b82f6' }] });
    const res = await request(app).get('/api/entity-tags?entityType=user');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('400 when entityType is missing', async () => {
    const res = await request(app).get('/api/entity-tags');
    expect(res.status).toBe(400);
  });
});
