// Unit tests for routes/contexts/roles.js — who answers for an organizational
// unit or a logical application. DB mocked; the auth gate is a passthrough.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../../db/connection.js';
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const { default: router, parseRoleBody, ROLE_BEARING_CATEGORIES } = await import('./roles.js');
const app = mountRouter(router);

const CTX  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P1   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const I1   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ROLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('parseRoleBody', () => {
  it('accepts a principal or an identity holder and lower-cases the id', () => {
    expect(parseRoleBody({ role: 'Accountable', principalId: P1.toUpperCase() }))
      .toEqual({ role: 'Accountable', holderCol: 'principalId', holderId: P1 });
    expect(parseRoleBody({ role: 'Responsible', identityId: I1 }))
      .toEqual({ role: 'Responsible', holderCol: 'identityId', holderId: I1 });
  });

  it.each([
    ['an unknown role', { role: 'Owner', principalId: P1 }, /role must be one of Accountable, Responsible/],
    ['no holder', { role: 'Accountable' }, /Exactly one of principalId or identityId/],
    ['both holders', { role: 'Accountable', principalId: P1, identityId: I1 }, /Exactly one of principalId or identityId/],
    ['a non-uuid holder', { role: 'Responsible', identityId: 'nope' }, /identityId must be a uuid/],
  ])('rejects %s', (_label, body, message) => {
    expect(parseRoleBody(body)).toMatchObject({ status: 400, message });
  });
});

describe('GET /contexts/:id/roles', () => {
  it('400 on a malformed id', async () => {
    expect((await request(app).get('/api/contexts/nope/roles')).status).toBe(400);
  });

  it('404 when the context is missing', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await request(app).get(`/api/contexts/${CTX}/roles`)).status).toBe(404);
  });

  it('returns the roles with the holder name from Principals or Identities', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX });
    const rows = [
      { id: ROLE, role: 'Accountable', principalId: P1, identityId: null, displayName: 'Boss', addedBy: 'algorithm' },
      { id: I1, role: 'Responsible', principalId: null, identityId: I1, displayName: 'Jan', addedBy: 'analyst' },
    ];
    query.mockResolvedValueOnce({ rows });
    const res = await request(app).get(`/api/contexts/${CTX}/roles`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('COALESCE(p."displayName", i."displayName") AS "displayName"');
    expect(sql).toContain('LEFT JOIN "Principals" p ON p.id = r."principalId"');
    expect(sql).toContain('LEFT JOIN "Identities" i ON i.id = r."identityId"');
    expect(sql).toContain(`ORDER BY (r.role = 'Accountable') DESC`);
    expect(params).toEqual([CTX]);
  });

  it('500 when the query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    expect((await request(app).get(`/api/contexts/${CTX}/roles`)).status).toBe(500);
  });
});

describe('PUT /contexts/:id/roles', () => {
  const put = (body) => request(app).put(`/api/contexts/${CTX}/roles`).send(body);

  it('400 on a malformed context id', async () => {
    expect((await request(app).put('/api/contexts/nope/roles').send({ role: 'Accountable', principalId: P1 })).status).toBe(400);
  });

  it('400 on an invalid body before any lookup', async () => {
    const res = await put({ role: 'Accountable' });
    expect(res.status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404 when the context is missing', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await put({ role: 'Accountable', principalId: P1 })).status).toBe(404);
  });

  it('only OrganizationalUnit and LogicalApplication carry roles', () => {
    expect([...ROLE_BEARING_CATEGORIES].sort()).toEqual(['LogicalApplication', 'OrganizationalUnit']);
  });

  it.each(['Segment', 'Tag', null])('400 on a context whose template (%s) carries no roles', async (contextCategory) => {
    queryOne.mockResolvedValueOnce({ contextCategory });
    const res = await put({ role: 'Responsible', principalId: P1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/organizational unit or a logical application/);
    expect(query).not.toHaveBeenCalled();
  });

  it('404 when the principal does not exist', async () => {
    queryOne.mockResolvedValueOnce({ contextCategory: 'OrganizationalUnit' });
    queryOne.mockResolvedValueOnce(null);
    const res = await put({ role: 'Responsible', principalId: P1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Principal not found');
    expect(queryOne.mock.calls[1][0]).toContain('FROM "Principals"');
    expect(queryOne.mock.calls[1][1]).toEqual([P1]);
  });

  it('404 when the identity does not exist', async () => {
    queryOne.mockResolvedValueOnce({ contextCategory: 'LogicalApplication' });
    queryOne.mockResolvedValueOnce(null);
    const res = await put({ role: 'Responsible', identityId: I1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Identity not found');
    expect(queryOne.mock.calls[1][0]).toContain('FROM "Identities"');
  });

  it('adds a Responsible as the analyst and answers with the holder name', async () => {
    queryOne.mockResolvedValueOnce({ contextCategory: 'LogicalApplication' });
    queryOne.mockResolvedValueOnce({ displayName: 'Jan' });
    query.mockResolvedValueOnce({ rows: [{ id: ROLE, role: 'Responsible', principalId: null, identityId: I1, addedBy: 'analyst' }] });
    const res = await put({ role: 'Responsible', identityId: I1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: ROLE, role: 'Responsible', principalId: null, identityId: I1, addedBy: 'analyst', displayName: 'Jan' });
    // One statement: no Accountable to clear.
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO "ContextRoles" ("contextId", "identityId", role, "addedBy")');
    expect(sql).toContain(`ON CONFLICT ("contextId", "identityId", role) WHERE "identityId" IS NOT NULL`);
    expect(sql).toContain(`DO UPDATE SET "addedBy" = 'analyst'`);
    expect(params).toEqual([CTX, I1, 'Responsible']);
  });

  it('an Accountable replaces the existing Accountable of the context', async () => {
    queryOne.mockResolvedValueOnce({ contextCategory: 'OrganizationalUnit' });
    queryOne.mockResolvedValueOnce({ displayName: 'Boss' });
    query.mockResolvedValueOnce({ rowCount: 1 }); // clear the other Accountable
    query.mockResolvedValueOnce({ rows: [{ id: ROLE, role: 'Accountable', principalId: P1, identityId: null, addedBy: 'analyst' }] });
    const res = await put({ role: 'Accountable', principalId: P1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'Accountable', principalId: P1, displayName: 'Boss' });
    const [delSql, delParams] = query.mock.calls[0];
    expect(delSql).toContain('DELETE FROM "ContextRoles"');
    expect(delSql).toContain(`role = 'Accountable' AND "principalId" IS DISTINCT FROM $2`);
    expect(delParams).toEqual([CTX, P1]);
    expect(query.mock.calls[1][0]).toContain(`ON CONFLICT ("contextId", "principalId", role) WHERE "principalId" IS NOT NULL`);
  });

  it('500 when the write rejects', async () => {
    queryOne.mockResolvedValueOnce({ contextCategory: 'OrganizationalUnit' });
    queryOne.mockResolvedValueOnce({ displayName: 'Boss' });
    query.mockRejectedValueOnce(new Error('boom'));
    expect((await put({ role: 'Responsible', principalId: P1 })).status).toBe(500);
  });
});

describe('DELETE /contexts/:id/roles/:roleId', () => {
  it('400 on a malformed id', async () => {
    expect((await request(app).delete(`/api/contexts/${CTX}/roles/nope`)).status).toBe(400);
    expect((await request(app).delete(`/api/contexts/nope/roles/${ROLE}`)).status).toBe(400);
  });

  it('204 when the role of this context is removed', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app).delete(`/api/contexts/${CTX}/roles/${ROLE}`);
    expect(res.status).toBe(204);
    expect(query.mock.calls[0][0]).toContain('WHERE id = $1 AND "contextId" = $2');
    expect(query.mock.calls[0][1]).toEqual([ROLE, CTX]);
  });

  it('404 when no role of this context has that id', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect((await request(app).delete(`/api/contexts/${CTX}/roles/${ROLE}`)).status).toBe(404);
  });

  it('500 when the delete rejects', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    expect((await request(app).delete(`/api/contexts/${CTX}/roles/${ROLE}`)).status).toBe(500);
  });
});
