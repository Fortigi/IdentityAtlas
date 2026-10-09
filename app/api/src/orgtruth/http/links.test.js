import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { mountRouter, mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
vi.mock('../../config/authConfig.js', async (orig) => ({ ...(await orig()), isAuthEnabled: vi.fn(() => false) }));

import { query, queryOne } from '../../db/connection.js';
import { isAuthEnabled } from '../../config/authConfig.js';
import router, { parseDetectBody, MAX_DETECT_ROWS } from './links.js';

const app = mountRouter(router);
const L1 = '10000000-0000-4000-8000-000000000001';
const E1 = '20000000-0000-4000-8000-000000000001';
const SRC = '40000000-0000-4000-8000-000000000001';

const recipe = {
  version: 1,
  entities: [
    { type: 'Project', nameColumn: 'Project' },
    { type: 'Person', nameColumn: 'Owner', attributes: [{ column: 'Owner mail', name: 'email' }, { column: 'Secret' }] },
  ],
  relations: [{ predicate: 'owner', from: 'Project', to: 'Person' }],
};
const rows = [
  { Project: 'Atlas', Owner: 'Ann Smith', 'Owner mail': 'ann@contoso.com', Secret: 'x' },
  { Project: 'Borealis', Owner: 'Bob Jones', 'Owner mail': 'bob@contoso.com', Secret: 'y' },
];
const principals = [
  { id: 'u1', displayName: 'Ann Smith', email: 'ann@contoso.com', employeeId: null, principalType: 'User' },
  { id: 'u2', displayName: 'Bob Jones', email: 'bob@contoso.com', employeeId: null, principalType: 'User' },
];

// queryOne also serves the feature flag (WorkerConfig): no override → the env decides.
let linkRow;
beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  isAuthEnabled.mockReturnValue(false);
  process.env.FEATURE_ORG_TRUTH = 'true';
  linkRow = { id: L1, orgEntityId: E1, targetType: 'Principal', targetId: 'u1', status: 'proposed' };
  queryOne.mockImplementation(async (sql) => {
    if (sql.includes('"WorkerConfig"')) return undefined;
    if (sql.includes('FROM "OrgLinks"') || sql.startsWith('UPDATE')) return linkRow;
    return null;
  });
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM "Principals"')) return { rows: principals };
    if (sql.startsWith('SELECT "id", "displayName"')) return { rows: [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
    if (sql.startsWith('UPDATE') || sql.startsWith('INSERT')) return { rows: [{ id: params[0] }] };
    return { rows: [] };
  });
});
afterAll(() => { delete process.env.FEATURE_ORG_TRUTH; });

describe('POST /org-truth/links/detect', () => {
  it('detects from rows: the Person owners match Principal.email uniquely', async () => {
    const r = await request(app).post('/api/org-truth/links/detect').send({ recipe, entityType: 'Person', rows });
    expect(r.status).toBe(200);
    expect(r.body.entityType).toBe('Person');
    expect(r.body.entities).toBe(2);
    expect(r.body.pairs[0]).toMatchObject({ attribute: 'email', targetType: 'Principal', targetField: 'email', type: 'exact', unique: 2, uniquePct: 100 });
  });

  it('the whitelist: a recipe attribute named like a column never reaches the target SELECT', async () => {
    const sneaky = { ...recipe, entities: [recipe.entities[0], { type: 'Person', nameColumn: 'Owner', attributes: [{ column: 'Secret', name: 'passwordHash' }] }] };
    await request(app).post('/api/org-truth/links/detect').send({ recipe: sneaky, entityType: 'Person', rows });
    const selects = query.mock.calls.map(c => c[0]).filter(sql => sql.startsWith('SELECT'));
    expect(selects).toHaveLength(4);
    for (const sql of selects) {
      expect(sql).not.toMatch(/passwordHash|Secret/);
      expect(sql).toMatch(/^SELECT "id", "displayName"(, "(email|employeeId|mail|externalId|principalType)")* FROM "(Principals|Identities|Resources|Contexts)"/);
    }
  });

  it('400 with the validator\'s sentences on an invalid recipe', async () => {
    const r = await request(app).post('/api/org-truth/links/detect').send({ recipe: { version: 2, entities: [] }, entityType: 'Person', rows });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('The recipe is not valid.');
    expect(r.body.errors).toEqual(expect.arrayContaining(['The recipe "version" must be 1.']));
  });

  it('400 when the entity type is not in the recipe, or neither rows nor a sourceId is sent', async () => {
    expect((await request(app).post('/api/org-truth/links/detect').send({ recipe, entityType: 'Team', rows })).status).toBe(400);
    const r = await request(app).post('/api/org-truth/links/detect').send({ recipe, entityType: 'Person', sourceId: 'abc' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Send a sourceId (UUID) or rows.');
  });

  it('404 for an unknown source', async () => {
    const r = await request(app).post('/api/org-truth/links/detect').send({ recipe, entityType: 'Person', sourceId: SRC });
    expect(r.status).toBe(404);
  });

  it('500 with a generic message when the target load fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(new Error('relation "Principals" does not exist'));
    const r = await request(app).post('/api/org-truth/links/detect').send({ recipe, entityType: 'Person', rows });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Could not detect link candidates.' });
    spy.mockRestore();
  });
});

describe('parseDetectBody', () => {
  it('trims the entity type and normalises the recipe (attribute names default to the column)', () => {
    const out = parseDetectBody({ recipe, entityType: ' Person ', rows: [] });
    expect(out.entityDef).toMatchObject({ type: 'Person', keyColumn: 'Owner', attributes: [{ column: 'Owner mail', name: 'email' }, { column: 'Secret', name: 'Secret' }] });
    expect(out.rows).toEqual([]);
  });
  it('caps the rows fallback', () => {
    const tooMany = Array.from({ length: MAX_DETECT_ROWS + 1 }, () => ({}));
    expect(() => parseDetectBody({ recipe, entityType: 'Person', rows: tooMany })).toThrow(/At most 20000 rows/);
  });
  it('passes a valid sourceId through', () => {
    expect(parseDetectBody({ recipe, entityType: 'Person', sourceId: SRC }).sourceId).toBe(SRC);
  });
  it('treats a missing body as an invalid recipe', () => {
    expect(() => parseDetectBody(undefined)).toThrow('The recipe is not valid.');
  });
});

describe('GET /org-truth/review', () => {
  it('lists proposed links by default', async () => {
    const r = await request(app).get('/api/org-truth/review');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'links', status: 'proposed', page: 1, pageSize: 50, total: 0, rows: [] });
  });
  it('kind=claims lists entity and relation claims', async () => {
    const r = await request(app).get('/api/org-truth/review?kind=claims&page=2');
    expect(r.body).toMatchObject({ kind: 'claims', page: 2, entities: { total: 0 }, relations: { total: 0 } });
  });
  it('400 on a bad status or page', async () => {
    expect((await request(app).get('/api/org-truth/review?status=open')).status).toBe(400);
    expect((await request(app).get('/api/org-truth/review?page=0')).status).toBe(400);
  });
});

describe('link overrides', () => {
  it('PUT confirmed answers the updated link', async () => {
    const r = await request(app).put(`/api/org-truth/links/${L1}/override`).send({ action: 'confirmed' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ link: { id: L1 } });
  });
  it('PUT 400 on a bad action, 404 on an unknown link', async () => {
    expect((await request(app).put(`/api/org-truth/links/${L1}/override`).send({ action: 'approve' })).status).toBe(400);
    linkRow = null;
    expect((await request(app).put(`/api/org-truth/links/${L1}/override`).send({ action: 'rejected' })).status).toBe(404);
  });
  it('PUT without a body is a bad action', async () => {
    expect((await request(app).put(`/api/org-truth/links/${L1}/override`)).status).toBe(400);
  });
  it('DELETE clears the override, 404 on an unknown link', async () => {
    const ok = await request(app).delete(`/api/org-truth/links/${L1}/override`);
    expect(ok.status).toBe(200);
    expect(ok.body.link.id).toBe(L1);
    linkRow = null;
    expect((await request(app).delete(`/api/org-truth/links/${L1}/override`)).status).toBe(404);
  });
});

describe('claim status', () => {
  it('PUT entities/:id/status and relations/:id/status', async () => {
    queryOne.mockImplementation(async (sql, params) => (sql.includes('"WorkerConfig"') ? undefined : { id: params[0], status: params[1] }));
    const e = await request(app).put(`/api/org-truth/entities/${E1}/status`).send({ status: 'accepted' });
    expect(e.status).toBe(200);
    expect(e.body).toEqual({ id: E1, status: 'accepted' });
    const rel = await request(app).put(`/api/org-truth/relations/${E1}/status`).send({ status: 'rejected' });
    expect(rel.body).toEqual({ id: E1, status: 'rejected' });
    expect(queryOne.mock.calls.at(-1)[0]).toMatch(/^UPDATE "OrgRelations"/);
  });
  it('400 on a status other than accepted/rejected', async () => {
    expect((await request(app).put(`/api/org-truth/entities/${E1}/status`).send({ status: 'proposed' })).status).toBe(400);
    expect((await request(app).put(`/api/org-truth/entities/${E1}/status`)).status).toBe(400);
  });
});

describe('gates (per route)', () => {
  const reader = mountRouterAs(router, () => ({ oid: 'r', permissions: new Set(['data.read']) }));

  it('every route answers 404 while the feature is off', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get('/api/org-truth/review')).status).toBe(404);
    expect((await request(app).put(`/api/org-truth/links/${L1}/override`).send({ action: 'confirmed' })).status).toBe(404);
  });

  it('a reader can list the queue but not write', async () => {
    isAuthEnabled.mockReturnValue(true);
    expect((await request(reader).get('/api/org-truth/review')).status).toBe(200);
    for (const [method, path, body] of [
      ['post', '/api/org-truth/links/detect', { recipe, entityType: 'Person', rows }],
      ['put', `/api/org-truth/links/${L1}/override`, { action: 'confirmed' }],
      ['delete', `/api/org-truth/links/${L1}/override`, undefined],
      ['put', `/api/org-truth/entities/${E1}/status`, { status: 'accepted' }],
      ['put', `/api/org-truth/relations/${E1}/status`, { status: 'accepted' }],
    ]) {
      const r = await request(reader)[method](path).send(body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });
});
