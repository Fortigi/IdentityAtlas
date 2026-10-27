// Route tests for GET /api/<kind>/:id/diff. DB mocked and routed by SQL text,
// so the order of the parallel queries doesn't matter. SQL correctness is
// covered by contract-tests/entityDiff.contract.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';

const { default: router } = await import('./recentChanges.js');
const { parseAt, UNCHANGED_CAP } = await import('./recentChanges/diff.js');
const app = mountRouter(router);

const USER = '11111111-1111-1111-1111-111111111111';
const ROLE = '22222222-2222-2222-2222-222222222222';
const GROUP = '33333333-3333-3333-3333-333333333333';
const AT = '2026-09-01T00:00:00.000Z';

// Scripted state: Carol moved from Sales to Finance after T, gained a business
// role, and kept a group.
function stage({ current = { id: USER, displayName: 'Carol', department: 'Finance' }, first, since = '2026-06-01T00:00:00Z' } = {}) {
  queryOne.mockImplementation(async (sql) => {
    if (sql.includes('to_jsonb(t) AS "row"')) return current ? { row: current } : null;
    if (sql.includes('min("changedAt")')) return { since };
    if (sql.includes('"prevData" FROM "_history"')) return first ?? null;
    return null;
  });
  query.mockImplementation(async (sql) => {
    if (sql.includes('WITH h AS') && sql.includes(`'ResourceAssignments' AND "rowData"->>'principalId'`)) {
      return { rows: [{ rowId: `${ROLE}|${USER}|Direct`, firstOp: 'I', firstPrev: null, lastOp: 'I',
        lastData: { resourceId: ROLE, principalId: USER, assignmentType: 'Direct', resourceType: 'BusinessRole' } }] };
    }
    if (sql.includes('count(*) OVER ()') && sql.includes('"ResourceAssignments"')) {
      return { rows: [
        { row: { resourceId: ROLE, principalId: USER, assignmentType: 'Direct' }, total: '2' },
        { row: { resourceId: GROUP, principalId: USER, assignmentType: 'Direct' }, total: '2' },
      ] };
    }
    if (sql.includes('FROM "Resources" WHERE id = ANY')) {
      return { rows: [{ id: ROLE, displayName: 'Head of Sales', resourceType: 'BusinessRole' }, { id: GROUP, displayName: 'Finance Team', resourceType: 'Group' }] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('parseAt', () => {
  it('accepts a past ISO date and rejects missing, malformed and future values', () => {
    expect(parseAt(AT)?.toISOString()).toBe(AT);
    expect(parseAt(undefined)).toBeNull();
    expect(parseAt('')).toBeNull();
    expect(parseAt(['2026-01-01'])).toBeNull();
    expect(parseAt('not a date')).toBeNull();
    expect(parseAt(new Date(Date.now() + 86_400_000).toISOString())).toBeNull();
  });
});

describe('GET /api/<kind>/:id/diff — validation', () => {
  it('400 on a malformed id', async () => {
    expect((await request(app).get(`/api/user/nope/diff?at=${AT}`)).status).toBe(400);
  });
  it('400 when at is missing or in the future', async () => {
    expect((await request(app).get(`/api/user/${USER}/diff`)).status).toBe(400);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await request(app).get(`/api/user/${USER}/diff?at=${future}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/past/);
  });
  it('404 when the entity has neither a row nor any history', async () => {
    stage({ current: null });
    expect((await request(app).get(`/api/user/${USER}/diff?at=${AT}`)).status).toBe(404);
  });
  it('500 when a query fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryOne.mockRejectedValue(new Error('boom'));
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get(`/api/user/${USER}/diff?at=${AT}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to load diff');
    spy.mockRestore();
  });
});

describe('GET /api/user/:id/diff', () => {
  it('returns the user then and now, with the added role only on the right', async () => {
    stage({ first: { operation: 'U', prevData: { id: USER, displayName: 'Carol', department: 'Sales' } } });
    const res = await request(app).get(`/api/user/${USER}/diff?at=${AT}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ at: AT, historySince: '2026-06-01T00:00:00Z', relationshipsTracked: true, omittedUnchanged: 0 });
    expect(res.body.before.attributes.department).toBe('Sales');
    expect(res.body.after.attributes.department).toBe('Finance');
    const names = side => res.body[side].relationships.map(i => `${i.group}:${i.label}`);
    expect(names('before')).toEqual(['Groups:Finance Team']);
    expect(names('after')).toEqual(['Business roles:Head of Sales', 'Groups:Finance Team']);
  });

  it('passes the cap plus the number of changed rows as the current-rows limit', async () => {
    stage();
    await request(app).get(`/api/user/${USER}/diff?at=${AT}`);
    const call = query.mock.calls.find(([sql]) => sql.includes('count(*) OVER ()') && sql.includes('"ResourceAssignments"'));
    expect(call[1]).toEqual([USER, UNCHANGED_CAP + 1]);
    expect(call[0]).toContain('"deletedAt" IS NULL');
    const im = query.mock.calls.find(([sql]) => sql.includes('count(*) OVER ()') && sql.includes('"IdentityMembers"'));
    expect(im[0]).not.toContain('deletedAt');
  });
});

describe('GET /api/contexts/:id/diff', () => {
  it('has no relationship sources and reports that', async () => {
    stage({ current: { id: USER, displayName: 'Ctx' } });
    const res = await request(app).get(`/api/contexts/${USER}/diff?at=${AT}`);
    expect(res.status).toBe(200);
    expect(res.body.relationshipsTracked).toBe(false);
    expect(res.body.before.relationships).toEqual([]);
    expect(query.mock.calls.some(([sql]) => sql.includes('WITH h AS'))).toBe(false);
  });

  it('reads the context table, not Principals', async () => {
    stage({ current: { id: USER, displayName: 'Ctx' } });
    await request(app).get(`/api/contexts/${USER}/diff?at=${AT}`);
    const sqls = queryOne.mock.calls.map(([sql]) => sql);
    expect(sqls.some(s => s.includes('FROM "Contexts" t'))).toBe(true);
    expect(queryOne.mock.calls.find(([s]) => s.includes('"prevData" FROM "_history"'))[1][0]).toBe('Contexts');
  });
});
