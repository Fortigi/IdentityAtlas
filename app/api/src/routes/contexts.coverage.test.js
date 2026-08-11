// Coverage unit tests for routes/contexts.js — exercises the happy paths,
// guards, and error branches of every endpoint with the DB, the member-count
// helper, and the plugin runner all mocked. Complements contexts.test.js
// (which pins POST /contexts validation) without duplicating its cases.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';
// Auth gate is asserted elsewhere; passthrough here so we reach the logic.
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
// Member-count roll-up touches the DB; stub it out so handlers don't error.
const recalcMemberCountsForChain = vi.fn(async () => {});
vi.mock('../contexts/memberCounts.js', () => ({
  recalcMemberCountsForChain: (...a) => recalcMemberCountsForChain(...a),
}));
// Plugin runner — never actually queue/execute a run.
const enqueueRun = vi.fn();
vi.mock('../contexts/plugins/runner.js', () => ({
  enqueueRun: (...a) => enqueueRun(...a),
}));

const { default: router } = await import('./contexts.js');
const app = mountRouter(router);

const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ID3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  recalcMemberCountsForChain.mockReset();
  enqueueRun.mockReset();
});

// ─── GET /contexts (list roots) ──────────────────────────────────────
describe('GET /contexts', () => {
  it('returns the root contexts', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, displayName: 'Root' }] });
    const res = await request(app).get('/api/contexts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: ID, displayName: 'Root' }], total: 1 });
  });

  it('applies targetType / variant / contextType / scopeSystemId filters', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/api/contexts?targetType=Principal&variant=manual&contextType=Department&scopeSystemId=7');
    expect(res.status).toBe(200);
    // Four filters + the IS NULL clause should be present in the WHERE.
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('targetType');
    expect(query.mock.calls[0][1]).toEqual(['Principal', 'manual', 'Department', 7]);
  });

  it('ignores invalid filter values', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/api/contexts?targetType=Bogus&variant=nope&scopeSystemId=abc');
    expect(query.mock.calls[0][1]).toEqual([]);
  });

  it('500 when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/contexts');
    expect(res.status).toBe(500);
  });
});

// ─── GET /contexts/tree ──────────────────────────────────────────────
describe('GET /contexts/tree', () => {
  it('returns [] when there are no rows', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/contexts/tree');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('nests children under parents and sorts by totalMemberCount', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: ID, parentContextId: null, displayName: 'Root', totalMemberCount: 5 },
      { id: ID2, parentContextId: ID, displayName: 'Child B', totalMemberCount: 1 },
      { id: ID3, parentContextId: ID, displayName: 'Child A', totalMemberCount: 9 },
    ] });
    const res = await request(app).get('/api/contexts/tree');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(ID);
    // Larger subtree (Child A, 9) bubbles before Child B (1).
    expect(res.body[0].children.map(c => c.id)).toEqual([ID3, ID2]);
  });

  it('400 when the root id is malformed', async () => {
    const res = await request(app).get('/api/contexts/tree?root=not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns the requested subtree when root is valid', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, parentContextId: null, displayName: 'R', totalMemberCount: 0 }] });
    const res = await request(app).get(`/api/contexts/tree?root=${ID}`);
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(ID);
    expect(query.mock.calls[0][1]).toEqual([ID]);
  });

  it('500 when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/contexts/tree');
    expect(res.status).toBe(500);
  });
});

// ─── GET /contexts/:id ───────────────────────────────────────────────
describe('GET /contexts/:id', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).get('/api/contexts/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404 when the context is not found', async () => {
    queryOne.mockResolvedValueOnce(null); // attr lookup
    const res = await request(app).get(`/api/contexts/${ID}`);
    expect(res.status).toBe(404);
  });

  it('returns attributes, members, and sub-contexts', async () => {
    queryOne.mockResolvedValueOnce({ id: ID, targetType: 'Identity', displayName: 'X' }); // attr
    query.mockResolvedValueOnce({ rows: [{ id: 'm1', displayName: 'Member' }] }); // loadMembers data
    query.mockResolvedValueOnce({ rows: [{ id: ID2, displayName: 'Sub' }] }); // subs
    const res = await request(app).get(`/api/contexts/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body.attributes.id).toBe(ID);
    expect(res.body.members).toEqual([{ id: 'm1', displayName: 'Member' }]);
    expect(res.body.subContexts).toEqual([{ id: ID2, displayName: 'Sub' }]);
  });

  it('returns empty members for an unknown targetType (no member table)', async () => {
    queryOne.mockResolvedValueOnce({ id: ID, targetType: 'Mystery' }); // attr
    query.mockResolvedValueOnce({ rows: [] }); // subs (loadMembers short-circuits)
    const res = await request(app).get(`/api/contexts/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([]);
  });

  it('500 when the attr query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/api/contexts/${ID}`);
    expect(res.status).toBe(500);
  });
});

// ─── GET /contexts/:id/members ───────────────────────────────────────
describe('GET /contexts/:id/members', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).get('/api/contexts/nope/members');
    expect(res.status).toBe(400);
  });

  it('404 when the context is not found', async () => {
    queryOne.mockResolvedValueOnce(null); // targetType lookup
    const res = await request(app).get(`/api/contexts/${ID}/members`);
    expect(res.status).toBe(404);
  });

  it('returns paginated members with total', async () => {
    queryOne.mockResolvedValueOnce({ targetType: 'Principal' }); // targetType lookup
    query.mockResolvedValueOnce({ rows: [{ id: 'm1', displayName: 'P' }] }); // data rows
    queryOne.mockResolvedValueOnce({ total: 1 }); // count
    const res = await request(app).get(`/api/contexts/${ID}/members?limit=10&offset=0`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: 'm1', displayName: 'P' }], total: 1 });
  });

  it('honours search + include=descendants', async () => {
    queryOne.mockResolvedValueOnce({ targetType: 'Identity' });
    query.mockResolvedValueOnce({ rows: [] });
    queryOne.mockResolvedValueOnce({ total: 0 });
    const res = await request(app).get(`/api/contexts/${ID}/members?search=foo&include=descendants`);
    expect(res.status).toBe(200);
    // search param is appended → data query carries the %foo% bind.
    expect(query.mock.calls[0][1]).toContain('%foo%');
  });

  it('500 when the data query rejects', async () => {
    queryOne.mockResolvedValueOnce({ targetType: 'Principal' });
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/api/contexts/${ID}/members`);
    expect(res.status).toBe(500);
  });
});

// ─── POST /contexts (create — happy path beyond contexts.test.js) ────
describe('POST /contexts', () => {
  it('201 with a valid parent of the same targetType', async () => {
    queryOne.mockResolvedValueOnce({ targetType: 'Principal' }); // parent lookup
    query.mockResolvedValueOnce({}); // INSERT
    queryOne.mockResolvedValueOnce({ id: 'new', displayName: 'Eng' }); // SELECT back
    const res = await request(app).post('/api/contexts').send({
      targetType: 'Principal', contextType: 'Department', displayName: 'Eng', parentContextId: ID,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'new' });
  });

  it('500 when the INSERT rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom')); // INSERT
    const res = await request(app).post('/api/contexts').send({
      targetType: 'Principal', contextType: 'Department', displayName: 'Eng',
    });
    expect(res.status).toBe(500);
  });
});

// ─── PATCH /contexts/:id ─────────────────────────────────────────────
describe('PATCH /contexts/:id', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).patch('/api/contexts/nope').send({ displayName: 'X' });
    expect(res.status).toBe(400);
  });

  it('404 when the context is not found', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ displayName: 'X' });
    expect(res.status).toBe(404);
  });

  it('400 when the context is synced (read-only)', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'synced', targetType: 'Identity' });
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ displayName: 'X' });
    expect(res.status).toBe(400);
  });

  it('400 when no updatable fields are supplied', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity' });
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ foo: 'bar' });
    expect(res.status).toBe(400);
  });

  it('renames a manual context', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity', displayName: 'Old', parentContextId: null });
    query.mockResolvedValueOnce({}); // UPDATE
    queryOne.mockResolvedValueOnce({ id: ID, displayName: 'New' }); // SELECT back
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ displayName: 'New' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'New' });
  });

  it('marks a generated context userRenamed when the name diverges', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'generated', targetType: 'Identity', displayName: 'Old', parentContextId: null });
    query.mockResolvedValueOnce({});
    queryOne.mockResolvedValueOnce({ id: ID, displayName: 'Renamed' });
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ displayName: 'Renamed' });
    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toContain('userRenamed');
  });

  it('400 when parentContextId is not a uuid', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity', displayName: 'X', parentContextId: null });
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ parentContextId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400 when parenting a context to itself', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity', displayName: 'X', parentContextId: null });
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ parentContextId: ID });
    expect(res.status).toBe(400);
  });

  it('400 when the proposed parent does not exist', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity', displayName: 'X', parentContextId: null });
    queryOne.mockResolvedValueOnce(null); // parent lookup
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ parentContextId: ID2 });
    expect(res.status).toBe(400);
  });

  it('400 when the proposed parent has a different targetType', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity', displayName: 'X', parentContextId: null });
    queryOne.mockResolvedValueOnce({ targetType: 'Resource' }); // parent of a different type
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ parentContextId: ID2 });
    expect(res.status).toBe(400);
  });

  it('400 when the reparent would create a cycle', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity', displayName: 'X', parentContextId: null });
    queryOne.mockResolvedValueOnce({ targetType: 'Identity' }); // parent lookup OK
    // wouldCreateCycle() runs a single ancestor-walk query; a non-empty result
    // means the proposed parent is a descendant of this node → reparent loops.
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ parentContextId: ID2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cycle/i);
  });

  it('reparents to null and recalculates member counts', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity', displayName: 'X', parentContextId: ID2 });
    query.mockResolvedValueOnce({}); // UPDATE
    queryOne.mockResolvedValueOnce({ id: ID }); // SELECT back
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ parentContextId: null });
    expect(res.status).toBe(200);
    // old parent chain recalculated (new is null).
    expect(recalcMemberCountsForChain).toHaveBeenCalledWith(ID2);
  });

  it('500 when the UPDATE rejects', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity', displayName: 'X', parentContextId: null });
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).patch(`/api/contexts/${ID}`).send({ displayName: 'Y' });
    expect(res.status).toBe(500);
  });
});

// ─── POST /contexts/:id/sync ─────────────────────────────────────────
describe('POST /contexts/:id/sync', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).post('/api/contexts/nope/sync');
    expect(res.status).toBe(400);
  });

  it('404 when the context is not found', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).post(`/api/contexts/${ID}/sync`);
    expect(res.status).toBe(404);
  });

  it('400 when the context is not a generated tree', async () => {
    queryOne.mockResolvedValueOnce({ id: ID, variant: 'manual', algorithmName: null });
    const res = await request(app).post(`/api/contexts/${ID}/sync`);
    expect(res.status).toBe(400);
  });

  it('202 and queues a run for a generated tree with an instance key', async () => {
    queryOne.mockResolvedValueOnce({
      id: ID, variant: 'generated', algorithmName: 'manager-hierarchy',
      sourceInstanceKey: 'key-1', sourceAlgorithmId: ID2, scopeSystemId: 3, sourceRunId: null,
    });
    enqueueRun.mockResolvedValueOnce('run-123');
    const res = await request(app).post(`/api/contexts/${ID}/sync`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ runId: 'run-123', instanceKey: 'key-1' });
  });

  it('mints an instance key + replays run parameters when missing', async () => {
    queryOne.mockResolvedValueOnce({
      id: ID, variant: 'generated', algorithmName: 'manager-hierarchy',
      sourceInstanceKey: null, sourceAlgorithmId: ID2, scopeSystemId: null, sourceRunId: ID3,
    });
    queryOne.mockResolvedValueOnce({ parameters: { rootName: 'Org' } }); // run params replay
    query.mockResolvedValueOnce({}); // UPDATE sourceInstanceKey
    enqueueRun.mockResolvedValueOnce('run-456');
    const res = await request(app).post(`/api/contexts/${ID}/sync`);
    expect(res.status).toBe(202);
    expect(res.body.runId).toBe('run-456');
    expect(res.body.instanceKey).toBeTruthy();
  });

  it('500 when the lookup rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post(`/api/contexts/${ID}/sync`);
    expect(res.status).toBe(500);
  });
});

// ─── DELETE /contexts/:id ────────────────────────────────────────────
describe('DELETE /contexts/:id', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).delete('/api/contexts/nope');
    expect(res.status).toBe(400);
  });

  it('404 when the context is not found', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).delete(`/api/contexts/${ID}`);
    expect(res.status).toBe(404);
  });

  it('400 when the context is synced', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'synced' });
    const res = await request(app).delete(`/api/contexts/${ID}`);
    expect(res.status).toBe(400);
  });

  it('204 when deleting a manual context', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual' });
    query.mockResolvedValueOnce({}); // DELETE
    const res = await request(app).delete(`/api/contexts/${ID}`);
    expect(res.status).toBe(204);
  });

  it('500 when the DELETE rejects', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'generated' });
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).delete(`/api/contexts/${ID}`);
    expect(res.status).toBe(500);
  });
});

// ─── POST /contexts/:id/members ──────────────────────────────────────
describe('POST /contexts/:id/members', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).post('/api/contexts/nope/members').send({ memberId: ID });
    expect(res.status).toBe(400);
  });

  it('404 when the context is not found', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).post(`/api/contexts/${ID}/members`).send({ memberId: ID2 });
    expect(res.status).toBe(404);
  });

  it('400 when the context is synced', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'synced', targetType: 'Identity' });
    const res = await request(app).post(`/api/contexts/${ID}/members`).send({ memberId: ID2 });
    expect(res.status).toBe(400);
  });

  it('400 when memberId is missing or not a uuid', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity' });
    const res = await request(app).post(`/api/contexts/${ID}/members`).send({ memberId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('201 when adding a member', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity' });
    query.mockResolvedValueOnce({}); // INSERT
    const res = await request(app).post(`/api/contexts/${ID}/members`).send({ memberId: ID2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ contextId: ID, memberId: ID2, memberType: 'Identity' });
    expect(recalcMemberCountsForChain).toHaveBeenCalledWith(ID);
  });

  it('500 when the INSERT rejects', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual', targetType: 'Identity' });
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post(`/api/contexts/${ID}/members`).send({ memberId: ID2 });
    expect(res.status).toBe(500);
  });
});

// ─── DELETE /contexts/:id/members/:memberId ──────────────────────────
describe('DELETE /contexts/:id/members/:memberId', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).delete(`/api/contexts/nope/members/${ID2}`);
    expect(res.status).toBe(400);
  });

  it('404 when the context is not found', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).delete(`/api/contexts/${ID}/members/${ID2}`);
    expect(res.status).toBe(404);
  });

  it('400 when the context is synced', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'synced' });
    const res = await request(app).delete(`/api/contexts/${ID}/members/${ID2}`);
    expect(res.status).toBe(400);
  });

  it('204 when removing a member', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual' });
    query.mockResolvedValueOnce({}); // DELETE
    const res = await request(app).delete(`/api/contexts/${ID}/members/${ID2}`);
    expect(res.status).toBe(204);
    expect(recalcMemberCountsForChain).toHaveBeenCalledWith(ID);
  });

  it('500 when the DELETE rejects', async () => {
    queryOne.mockResolvedValueOnce({ variant: 'manual' });
    query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).delete(`/api/contexts/${ID}/members/${ID2}`);
    expect(res.status).toBe(500);
  });
});

// ─── PATCH /contexts/:id/members/:memberId/move ──────────────────────
describe('PATCH /contexts/:id/members/:memberId/move', () => {
  it('400 on a malformed toContextId', async () => {
    const res = await request(app).patch(`/api/contexts/${ID}/members/${ID2}/move`).send({ toContextId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400 when source and target are the same', async () => {
    const res = await request(app).patch(`/api/contexts/${ID}/members/${ID2}/move`).send({ toContextId: ID });
    expect(res.status).toBe(400);
  });

  it('404 when a context is not found', async () => {
    queryOne.mockResolvedValueOnce(null); // from
    queryOne.mockResolvedValueOnce({ contextType: 'ManagerHierarchy', targetType: 'Principal' }); // to
    const res = await request(app).patch(`/api/contexts/${ID}/members/${ID2}/move`).send({ toContextId: ID3 });
    expect(res.status).toBe(404);
  });

  it('400 when not in the Manager Hierarchy tree', async () => {
    queryOne.mockResolvedValueOnce({ contextType: 'Department', targetType: 'Principal' }); // from
    queryOne.mockResolvedValueOnce({ contextType: 'Department', targetType: 'Principal' }); // to
    const res = await request(app).patch(`/api/contexts/${ID}/members/${ID2}/move`).send({ toContextId: ID3 });
    expect(res.status).toBe(400);
  });

  it('moves a member and sets a manager override', async () => {
    queryOne.mockResolvedValueOnce({ contextType: 'ManagerHierarchy', targetType: 'Principal' }); // from
    queryOne.mockResolvedValueOnce({ contextType: 'ManagerHierarchy', targetType: 'Principal', externalId: ID }); // to (manager id)
    queryOne.mockResolvedValueOnce({ managerId: 'someone-else' }); // principal's current manager → override path
    query.mockResolvedValue({}); // override upsert + member delete/insert
    const res = await request(app).patch(`/api/contexts/${ID2}/members/${ID3}/move`).send({ toContextId: ID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ from: ID2, to: ID, memberId: ID3 });
    expect(recalcMemberCountsForChain).toHaveBeenCalledWith(ID2);
    expect(recalcMemberCountsForChain).toHaveBeenCalledWith(ID);
  });

  it('clears the override when dropped back on the source manager', async () => {
    queryOne.mockResolvedValueOnce({ contextType: 'ManagerHierarchy', targetType: 'Principal' }); // from
    queryOne.mockResolvedValueOnce({ contextType: 'ManagerHierarchy', targetType: 'Principal', externalId: ID }); // to
    queryOne.mockResolvedValueOnce({ managerId: ID }); // matches target manager → clear override
    query.mockResolvedValue({});
    const res = await request(app).patch(`/api/contexts/${ID2}/members/${ID3}/move`).send({ toContextId: ID });
    expect(res.status).toBe(200);
    // DELETE FROM ManagerHierarchyOverrides should be issued.
    const deletedOverride = query.mock.calls.some(c => /ManagerHierarchyOverrides/.test(c[0]) && /DELETE/.test(c[0]));
    expect(deletedOverride).toBe(true);
  });

  it('500 when the move queries reject', async () => {
    queryOne.mockResolvedValueOnce({ contextType: 'ManagerHierarchy', targetType: 'Principal' });
    queryOne.mockResolvedValueOnce({ contextType: 'ManagerHierarchy', targetType: 'Principal', externalId: ID });
    queryOne.mockRejectedValueOnce(new Error('boom')); // principal lookup rejects
    const res = await request(app).patch(`/api/contexts/${ID2}/members/${ID3}/move`).send({ toContextId: ID });
    expect(res.status).toBe(500);
  });
});
