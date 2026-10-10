// Interviews API — gates, entity search and the interview context read.
// Sessions: interviews.sessions.test.js. Claims and review: interviews.claims.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountRouterAs } from '../../test-utils/routeTestKit.js';
import { scriptedDb } from '../../test-utils/scriptedDb.js';

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: () => auth.enabled,
  getJwksClient: () => null, getTenantId: () => '', getClientId: () => '', getRequiredRoles: () => null, getRolePermissions: () => ({}),
}));
vi.mock('../db/connection.js');

import { query } from '../db/connection.js';
import router from './interviews.js';
import { SEARCH_PER_MINUTE } from '../interviews/http/gates.js';
import williamFixture from '../interviews/fixtures/search-william.json';
import peterFixture from '../interviews/fixtures/search-peter.json';
import notFoundFixture from '../interviews/fixtures/search-productieomgeving.json';

const SCOPE = '22222222-2222-4222-8222-222222222222';
const ID = '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab';
let caller = 0;
const analyst = (perms = ['*']) => ({ oid: `u-${++caller}`, permissions: new Set(perms) });
const appAs = (user) => mountRouterAs(router, () => user);

const W = { id: 'a1b2c3d4-0000-4000-8000-000000000001', displayName: 'William de Boer', l1: 'Platform engineer', l2: 'ICT Beheer', l3: null, score: '0.71', inScope: true };
const P1 = { id: 'a1b2c3d4-0000-4000-8000-000000000002', displayName: 'Peter Jansen', l1: 'Database administrator', l2: 'ICT Beheer', l3: null, score: '0.64', inScope: false };
const P2 = { id: 'a1b2c3d4-0000-4000-8000-000000000003', displayName: 'Peter de Vries', l1: 'Controller', l2: 'Finance', l3: null, score: '0.64', inScope: false };

/** Every route the composed router declares, read from the router itself. */
function allRoutes() {
  const out = [];
  for (const layer of router.stack) {
    for (const l of layer.handle?.stack ?? []) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push([m, `/api${l.route.path.replace(/:\w+/g, ID)}`]);
    }
  }
  return out;
}

beforeEach(() => {
  query.mockReset();
  auth.enabled = false;
  process.env.FEATURE_INTERVIEWS = 'true';
});

describe('gates', () => {
  it('answers 404 on every route while the feature is off, without touching the database', async () => {
    process.env.FEATURE_INTERVIEWS = 'false';
    const routes = allRoutes();
    expect(routes.length).toBe(12);
    for (const [method, path] of routes) {
      const res = await request(appAs(analyst()))[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('checks the permission before the feature: no permission is 403 even while it is off', async () => {
    auth.enabled = true;
    process.env.FEATURE_INTERVIEWS = 'false';
    const res = await request(appAs(analyst([]))).get('/api/v1/interviews/entities/search?q=Peter');
    expect(res.status).toBe(403);
  });

  it('lets data.read search but not create an interview, which needs data.write.contexts', async () => {
    auth.enabled = true;
    scriptedDb(query, [[/WITH RECURSIVE scope/, []]]);
    const reader = appAs(analyst(['data.read']));
    expect((await request(reader).get('/api/v1/interviews/entities/search?q=Peter')).status).toBe(200);
    const create = await request(reader).post('/api/v1/interviews').send({});
    expect(create.status).toBe(403);
    expect(create.body.required).toEqual(['data.write.contexts']);
  });

  it('refuses read API keys on interview reads, which data.read alone would let through', async () => {
    auth.enabled = true;
    const app = express();
    app.use((req, _res, next) => { req.readToken = { id: 7, name: 'bi' }; next(); });
    app.use('/api', router);
    const res = await request(app).get('/api/v1/interviews/entities/search?q=Peter');
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /v1/interviews/entities/search', () => {
  const search = (user, qs) => request(appAs(user)).get(`/api/v1/interviews/entities/search?${qs}`);

  it('"William" with one match comes back SUGGESTED, never confirmed — the mock fixture is this exact answer', async () => {
    scriptedDb(query, [[/WITH RECURSIVE scope/, [W]]]);
    const res = await search(analyst(), `q=William&scopeContextId=${SCOPE}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(williamFixture);
    expect(res.body.outcome.state).toBe('suggested');
  });

  it('"Peter" with two matches stays ambiguous: both shown, neither picked — the mock fixture is this exact answer', async () => {
    scriptedDb(query, [[/WITH RECURSIVE scope/, [P1, P2]]]);
    const res = await search(analyst(), `q=Peter&scopeContextId=${SCOPE}`);
    expect(res.body).toEqual(peterFixture);
    expect(res.body.outcome).toEqual({ state: 'unresolved', entityId: null, reason: 'ambiguous' });
    expect(res.body.candidates.map(c => c.label)).toEqual(['Database administrator · ICT Beheer', 'Controller · Finance']);
  });

  it('"productieomgeving" with no match is not_found — the mock fixture is this exact answer', async () => {
    scriptedDb(query, [[/WITH RECURSIVE scope/, []]]);
    const res = await search(analyst(), 'q=productieomgeving&kind=resource');
    expect(res.body).toEqual(notFoundFixture);
    expect(res.body.outcome.state).toBe('not_found');
  });

  it('passes the trimmed words and the scope to the query, nothing else', async () => {
    const db = scriptedDb(query, [[/WITH RECURSIVE scope/, []]]);
    await search(analyst(), `q=%20%20Peter%20&kind=account&scopeContextId=${SCOPE}`);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].params).toEqual(['Peter', '%Peter%', SCOPE]);
    expect(db.calls[0].sql).toContain('FROM "Principals" n0');
  });

  it('refuses a one-letter query, an unknown kind and a malformed scope before searching', async () => {
    for (const qs of ['q=P', `q=${'x'.repeat(101)}`, 'q=Peter&kind=person', 'q=Peter&scopeContextId=team-a']) {
      expect((await search(analyst(), qs)).status, qs).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('answers a generic 500 when the database fails, without the error text', async () => {
    query.mockRejectedValue(new Error('relation "Identities" does not exist'));
    const res = await search(analyst(), 'q=Peter');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('Identities');
  });

  it(`allows ${SEARCH_PER_MINUTE} lookups a minute per caller, refuses the next, and counts callers apart`, async () => {
    scriptedDb(query, [[/WITH RECURSIVE scope/, []]]);
    const busy = appAs(analyst());
    for (let i = 0; i < SEARCH_PER_MINUTE; i++) {
      const ok = await request(busy).get('/api/v1/interviews/entities/search?q=Peter');
      if (ok.status !== 200) throw new Error(`lookup ${i + 1} answered ${ok.status}`);
    }
    const over = await request(busy).get('/api/v1/interviews/entities/search?q=Peter');
    expect(over.status).toBe(429);
    expect(query).toHaveBeenCalledTimes(SEARCH_PER_MINUTE);
    expect((await search(analyst(), 'q=Peter')).status).toBe(200);
  });
});

describe('GET /v1/interviews/context', () => {
  it('needs a subject or a scope, as UUIDs', async () => {
    expect((await request(appAs(analyst())).get('/api/v1/interviews/context')).status).toBe(400);
    expect((await request(appAs(analyst())).get('/api/v1/interviews/context?scopeContextId=x')).status).toBe(400);
  });

  it('passes a 404 for an unknown scope through', async () => {
    scriptedDb(query, [[/FROM "Contexts" c WHERE c."id" = \$1/, []]]);
    const res = await request(appAs(analyst())).get(`/api/v1/interviews/context?scopeContextId=${SCOPE}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Scope context not found');
  });

  it('returns the team with what each member holds', async () => {
    scriptedDb(query, [
      [/WITH RECURSIVE[\s\S]*people AS/, [{ id: P1.id, kind: 'identity', displayName: 'Peter Jansen', jobTitle: 'DBA', department: 'ICT', direct: '3', indirect: '1', eligible: '0', total: '1' }]],
      [/WITH RECURSIVE[\s\S]*GROUP BY r\."id"/, []],
      [/FROM "Contexts" c WHERE c."id" = \$1/, [{ id: SCOPE, displayName: 'ICT Beheer', contextType: 'Department', targetType: 'Identity' }]],
    ]);
    const res = await request(appAs(analyst())).get(`/api/v1/interviews/context?scopeContextId=${SCOPE}`);
    expect(res.status).toBe(200);
    expect(res.body.scope.members.items[0]).toMatchObject({ displayName: 'Peter Jansen', direct: 3, indirect: 1, eligible: 0 });
  });
});
