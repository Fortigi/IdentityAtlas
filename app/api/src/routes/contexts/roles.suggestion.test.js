// Unit tests for the best-guess routes in routes/contexts/roles.js:
// GET /contexts/:id/roles/suggestion and POST /contexts/:id/roles/suggestion/reject.
// DB mocked; the scoring module is mocked so these pin the route's own gates.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
vi.mock('../../contexts/roleSuggestion.js', () => ({ suggestAccountable: vi.fn() }));
import { suggestAccountable } from '../../contexts/roleSuggestion.js';

const { default: router } = await import('./roles.js');
const app = mountRouterAs(router, () => ({ email: 'ana@example.com' }));

const CTX = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P1  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const I1  = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  suggestAccountable.mockReset();
});

describe('GET /contexts/:id/roles/suggestion', () => {
  const get = () => request(app).get(`/api/contexts/${CTX}/roles/suggestion`);
  const SUGGESTION = {
    role: 'Accountable', principalId: P1, displayName: 'Boss',
    reason: 'manages 11 of the 14 members', count: 11, total: 14,
  };

  it('400 on a malformed id', async () => {
    expect((await request(app).get('/api/contexts/nope/roles/suggestion')).status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404 when the context is missing', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
  });

  it('200 with the suggestion for an organizational unit without an Accountable', async () => {
    const ctx = { id: CTX, contextCategory: 'OrganizationalUnit', targetType: 'Principal', hasAccountable: false };
    queryOne.mockResolvedValueOnce(ctx);
    suggestAccountable.mockResolvedValueOnce(SUGGESTION);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUGGESTION);
    expect(suggestAccountable).toHaveBeenCalledWith(ctx);
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain(`WHERE r."contextId" = c.id AND r.role = 'Accountable') AS "hasAccountable"`);
    expect(params).toEqual([CTX]);
  });

  it('a logical application is asked too', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX, contextCategory: 'LogicalApplication', targetType: 'Resource', hasAccountable: false });
    suggestAccountable.mockResolvedValueOnce({ ...SUGGESTION, reason: 'owns 4 of its 6 resources' });
    expect((await get()).status).toBe(200);
  });

  it('204 without asking when the context already has an Accountable', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX, contextCategory: 'OrganizationalUnit', targetType: 'Principal', hasAccountable: true });
    const res = await get();
    expect(res.status).toBe(204);
    expect(suggestAccountable).not.toHaveBeenCalled();
  });

  it.each(['Segment', 'Tag', null])('204 without asking on a %s context, which carries no roles', async (contextCategory) => {
    queryOne.mockResolvedValueOnce({ id: CTX, contextCategory, targetType: 'Principal', hasAccountable: false });
    expect((await get()).status).toBe(204);
    expect(suggestAccountable).not.toHaveBeenCalled();
  });

  it('204 when no signal gives a candidate', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX, contextCategory: 'OrganizationalUnit', targetType: 'Identity', hasAccountable: false });
    suggestAccountable.mockResolvedValueOnce(null);
    const res = await get();
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('500 when the lookup rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    expect((await get()).status).toBe(500);
  });
});

describe('POST /contexts/:id/roles/suggestion/reject', () => {
  const reject = (body) => request(app).post(`/api/contexts/${CTX}/roles/suggestion/reject`).send(body);

  it('400 on a malformed context id', async () => {
    expect((await request(app).post('/api/contexts/nope/roles/suggestion/reject').send({ principalId: P1 })).status).toBe(400);
  });

  it.each([
    ['no holder', {}, /Exactly one of principalId or identityId/],
    ['both holders', { principalId: P1, identityId: I1 }, /Exactly one of principalId or identityId/],
    ['a non-uuid holder', { principalId: 'nope' }, /principalId must be a uuid/],
  ])('400 on %s, before any lookup', async (_label, body, message) => {
    const res = await reject(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('a role in the body cannot turn the rejection into something else', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX });
    queryOne.mockResolvedValueOnce({ id: P1 });
    query.mockResolvedValueOnce({ rowCount: 1 });
    expect((await reject({ role: 'Owner', principalId: P1 })).status).toBe(204);
    expect(query.mock.calls[0][0]).toContain(`VALUES ($1, $2, 'Accountable', $3)`);
  });

  it('404 when the context is missing', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await reject({ principalId: P1 })).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('404 when the principal does not exist', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX });
    queryOne.mockResolvedValueOnce(null);
    const res = await reject({ principalId: P1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Principal not found');
    expect(queryOne.mock.calls[1][0]).toContain('FROM "Principals"');
    expect(query).not.toHaveBeenCalled();
  });

  it('404 when the identity does not exist', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX });
    queryOne.mockResolvedValueOnce(null);
    const res = await reject({ identityId: I1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Identity not found');
    expect(queryOne.mock.calls[1][0]).toContain('FROM "Identities"');
  });

  it('204 and stores the rejection of an account with who rejected it', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX });
    queryOne.mockResolvedValueOnce({ id: P1 });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await reject({ principalId: P1.toUpperCase() });
    expect(res.status).toBe(204);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO "ContextRoleSuggestionRejections" ("contextId", "principalId", role, "rejectedBy")');
    expect(sql).toContain('ON CONFLICT ("contextId", "principalId", role) WHERE "principalId" IS NOT NULL DO NOTHING');
    expect(params).toEqual([CTX, P1, 'ana@example.com']);
  });

  it('a person is stored in identityId', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX });
    queryOne.mockResolvedValueOnce({ id: I1 });
    query.mockResolvedValueOnce({ rowCount: 1 });
    expect((await reject({ identityId: I1 })).status).toBe(204);
    expect(query.mock.calls[0][0]).toContain('("contextId", "identityId", role, "rejectedBy")');
    expect(query.mock.calls[0][0]).toContain('WHERE "identityId" IS NOT NULL DO NOTHING');
  });

  it('idempotent: a rejection already stored is still 204', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX });
    queryOne.mockResolvedValueOnce({ id: P1 });
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect((await reject({ principalId: P1 })).status).toBe(204);
  });

  it('500 when the write rejects', async () => {
    queryOne.mockResolvedValueOnce({ id: CTX });
    queryOne.mockResolvedValueOnce({ id: P1 });
    query.mockRejectedValueOnce(new Error('boom'));
    expect((await reject({ principalId: P1 })).status).toBe(500);
  });
});

describe('POST reject without a body', () => {
  it('400, before any lookup', async () => {
    const res = await request(app).post(`/api/contexts/${CTX}/roles/suggestion/reject`);
    expect(res.status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });
});

describe('without SQL configured', () => {
  it('the suggestion is 204 and a rejection is 503, neither touching the database', async () => {
    process.env.USE_SQL = 'false';
    vi.resetModules();
    const { default: noSqlRouter } = await import('./roles.js');
    const noSql = mountRouterAs(noSqlRouter, () => ({}));
    process.env.USE_SQL = 'true';
    expect((await request(noSql).get(`/api/contexts/${CTX}/roles/suggestion`)).status).toBe(204);
    expect((await request(noSql).post(`/api/contexts/${CTX}/roles/suggestion/reject`).send({ principalId: P1 })).status).toBe(503);
    expect(queryOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
