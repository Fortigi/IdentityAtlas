import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));

import { query, queryOne } from '../../db/connection.js';
import router, { readProfileBody, MAX_NAME_LENGTH } from './profiles.js';

const app = mountRouter(router);
const ID = '6f1c1c2e-8d3b-4a8e-9c1d-2b3c4d5e6f70';
const recipe = {
  version: 1,
  entities: [{ type: ' Project ', keyColumn: 'Code', nameColumn: 'Project' }, { type: 'Person', nameColumn: 'Owner', attributes: [{ column: 'Mail', name: 'email' }] }],
  relations: [{ predicate: 'owner', from: 'Project', to: 'Person' }],
};
const linkRules = [{ entityType: 'Person', targetType: 'Principal', signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }];
const body = { name: ' Projects ', sourceKind: 'list', recipe, linkRules };

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue(undefined);
});

const insertCall = () => queryOne.mock.calls.find(([sql]) => sql.includes('INSERT INTO "OrgImportProfiles"'));

describe('gates', () => {
  it.each([
    ['get', '/api/org-truth/profiles', 'data.read'],
    ['get', `/api/org-truth/profiles/${ID}`, 'data.read'],
    ['post', '/api/org-truth/profiles', 'data.write.contexts'],
    ['put', `/api/org-truth/profiles/${ID}`, 'data.write.contexts'],
  ])('%s %s needs %s', async (method, path, perm) => {
    const r = await request(app)[method](path).set('x-deny', perm).send(body);
    expect(r.status).toBe(403);
  });
});

describe('readProfileBody', () => {
  it('normalises the recipe and rules and trims the name', () => {
    const { value, errors } = readProfileBody(body);
    expect(errors).toBeUndefined();
    expect(value.name).toBe('Projects');
    expect(value.sourceKind).toBe('list');
    expect(value.recipe.entities[0]).toEqual({ type: 'Project', nameColumn: 'Project', keyColumn: 'Code', attributes: [] });
    expect(value.recipe.entities[1].keyColumn).toBe('Owner');
    expect(value.linkRules[0]).toMatchObject({ threshold: 50, signals: [expect.objectContaining({ name: 'email→email', order: 0 })] });
  });

  it('defaults sourceKind to list and linkRules to none', () => {
    const { value } = readProfileBody({ name: 'X', recipe });
    expect(value.sourceKind).toBe('list');
    expect(value.linkRules).toEqual([]);
  });

  it('collects every problem as a sentence', () => {
    expect(readProfileBody({ ...body, name: '  ' }).errors).toEqual(['The profile needs a "name".']);
    expect(readProfileBody({ ...body, name: 42 }).errors).toEqual(['The profile needs a "name".']);
    expect(readProfileBody({ ...body, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }).errors).toEqual([`The profile name is longer than ${MAX_NAME_LENGTH} characters.`]);
    expect(readProfileBody({ ...body, name: 'x'.repeat(MAX_NAME_LENGTH) }).errors).toBeUndefined();
    expect(readProfileBody({ ...body, sourceKind: 'fax' }).errors).toEqual(['sourceKind "fax" is not one of list, transcript, email, manual.']);
    expect(readProfileBody({ ...body, recipe: { ...recipe, version: 2 } }).errors).toEqual(['The recipe "version" must be 1.']);
    expect(readProfileBody({ ...body, linkRules: [{ ...linkRules[0], entityType: 'Ghost' }] }).errors)
      .toEqual(['Link rule 1 is for entity type "Ghost", which the recipe does not define.']);
    expect(readProfileBody(undefined).errors.length).toBeGreaterThan(1);
  });
});

describe('GET /org-truth/profiles', () => {
  it('lists latest versions first, optionally for one name', async () => {
    query.mockResolvedValue({ rows: [{ id: ID, isLatest: true }] });
    const r = await request(app).get('/api/org-truth/profiles');
    expect(r.body).toEqual([{ id: ID, isLatest: true }]);
    expect(query.mock.calls[0][1]).toEqual([null]);
    expect(query.mock.calls[0][0]).toMatch(/ORDER BY "isLatest" DESC, "name", "version" DESC/);
    await request(app).get('/api/org-truth/profiles?name=Projects');
    expect(query.mock.calls[1][1]).toEqual(['Projects']);
    await request(app).get('/api/org-truth/profiles?name=');
    expect(query.mock.calls[2][1]).toEqual([null]);
  });
});

describe('GET /org-truth/profiles/:id', () => {
  it('returns one version or 404', async () => {
    queryOne.mockImplementation(async (sql, p) => (p?.[0] === ID ? { id: ID, version: 2 } : undefined));
    expect((await request(app).get(`/api/org-truth/profiles/${ID}`)).body).toEqual({ id: ID, version: 2 });
    const r = await request(app).get('/api/org-truth/profiles/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Profile not found.' });
  });
});

describe('POST /org-truth/profiles', () => {
  it('stores version 1 with the normalised recipe and rules', async () => {
    queryOne.mockImplementation(async (sql) => (sql.includes('INSERT') ? { id: ID, version: 1 } : undefined));
    const r = await request(app).post('/api/org-truth/profiles').send(body);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: ID, version: 1 });
    const [sql, params] = insertCall();
    expect(sql).toMatch(/VALUES \(\$1, \$2, 1, /);
    expect(params[1]).toBe('Projects');
    expect(JSON.parse(params[3]).entities[0].type).toBe('Project');
    expect(JSON.parse(params[4])[0].threshold).toBe(50);
    expect(params[5]).toBe('anonymous');
  });

  it('answers 400 with the sentences for an invalid profile', async () => {
    const r = await request(app).post('/api/org-truth/profiles').send({ ...body, recipe: { version: 1, entities: [], relations: [] } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'The profile is not valid.', errors: ['The recipe needs at least one entity.', expect.stringContaining('"Person"')] });
    expect(insertCall()).toBeUndefined();
  });

  it('answers 409 when the name exists, and also when the insert races with another', async () => {
    queryOne.mockImplementation(async (sql) => (sql.includes('SELECT 1') ? { taken: 1 } : undefined));
    const taken = await request(app).post('/api/org-truth/profiles').send(body);
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/"Projects" already exists; save a new version with PUT/);
    expect(insertCall()).toBeUndefined();

    queryOne.mockImplementation(async (sql) => { if (sql.includes('INSERT')) throw Object.assign(new Error('dup'), { code: '23505' }); });
    expect((await request(app).post('/api/org-truth/profiles').send(body)).status).toBe(409);
  });

  it('answers 500 for any other database error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    queryOne.mockImplementation(async (sql) => { if (sql.includes('INSERT')) throw new Error('gone'); });
    expect((await request(app).post('/api/org-truth/profiles').send(body)).status).toBe(500);
  });
});

describe('PUT /org-truth/profiles/:id', () => {
  const current = { id: ID, name: 'Projects', version: 3 };

  it('inserts the next version of the same name, ignoring a name in the body', async () => {
    queryOne.mockImplementation(async (sql) => {
      if (sql.includes('INSERT')) return { id: 'new', version: 4 };
      if (sql.includes('FROM "OrgImportProfiles" WHERE "id"')) return current;
      return undefined;
    });
    const r = await request(app).put(`/api/org-truth/profiles/${ID}`).send({ ...body, name: 'Renamed' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 'new', version: 4 });
    const [sql, params] = insertCall();
    expect(sql).toMatch(/COALESCE\(MAX\("version"\), 0\) \+ 1/);
    expect(params[0]).not.toBe(ID);
    expect(params[1]).toBe('Projects');
    expect(query).not.toHaveBeenCalled(); // never an UPDATE of the old version
  });

  it('answers 404 for an unknown profile and 400 for an invalid body', async () => {
    expect((await request(app).put(`/api/org-truth/profiles/${ID}`).send(body)).status).toBe(404);
    queryOne.mockImplementation(async (sql) => (sql.includes('WHERE "id"') ? current : undefined));
    const bad = await request(app).put(`/api/org-truth/profiles/${ID}`).send({ recipe: null });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0]).toBe('The recipe must be an object with "entities" and "relations".');
  });

  it('answers 409 on a version race and 500 on anything else', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = { code: '23505' };
    queryOne.mockImplementation(async (sql) => {
      if (sql.includes('INSERT')) throw Object.assign(new Error('x'), fail);
      return sql.includes('WHERE "id"') ? current : undefined;
    });
    const race = await request(app).put(`/api/org-truth/profiles/${ID}`).send(body);
    expect(race.status).toBe(409);
    expect(race.body.error).toMatch(/another version of this profile at the same moment/);
    fail = {};
    expect((await request(app).put(`/api/org-truth/profiles/${ID}`).send(body)).status).toBe(500);
  });
});
