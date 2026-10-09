import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// The run's collaborators are mocked first: linking (T2) and the projection runner.
vi.mock('../linking/run.js', () => ({ linkRun: vi.fn(async ({ runId }) => ({ runId, linked: 1, proposed: 0, ambiguous: 0, none: 0 })) }));
vi.mock('../../contexts/plugins/runner.js', () => ({ enqueueRun: vi.fn(async () => ({})) }));
vi.mock('../../db/connection.js');
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));

import { mountRouter } from '../../../test-utils/routeTestKit.js';

import { query, queryOne } from '../../db/connection.js';
import { linkRun } from '../linking/run.js';
import { enqueueRun } from '../../contexts/plugins/runner.js';
import router, { RUN_LIST_LIMIT } from './runs.js';
import composed from '../../routes/orgTruth.js';

const app = mountRouter(router);
const SRC = '22222222-2222-4222-8222-222222222222';
const PROF = '33333333-3333-4333-8333-333333333333';
const RUN = '11111111-1111-4111-8111-111111111111';
const CSV = 'Code;Project;Owner\nP-1;Atlas;Ann\nP-2;Beacon;Ann\n';
const recipe = {
  version: 1,
  entities: [{ type: 'Project', keyColumn: 'Code', nameColumn: 'Project' }, { type: 'Person', nameColumn: 'Owner' }],
  relations: [{ predicate: 'owner', from: 'Project', to: 'Person' }],
};

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  vi.clearAllMocks();
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('gates', () => {
  it.each([
    ['post', '/api/org-truth/runs/dry-run', 'data.write.contexts'],
    ['post', '/api/org-truth/runs', 'data.write.contexts'],
    ['get', '/api/org-truth/runs', 'data.read'],
    ['get', `/api/org-truth/runs/${RUN}`, 'data.read'],
  ])('%s %s needs %s', async (method, path, perm) => {
    expect((await request(app)[method](path).set('x-deny', perm).send({})).status).toBe(403);
  });
});

describe('POST /org-truth/runs/dry-run', () => {
  const withSource = (extra = {}) => queryOne.mockImplementation(async (sql, p) => {
    if (sql.includes('"OrgSources"') && p[0] === SRC) return { id: SRC, fileName: 'p.csv', content: Buffer.from(CSV) };
    if (sql.includes('"OrgImportProfiles"') && p[0] === PROF) return extra.profile;
    return undefined;
  });

  it('answers the report without writing', async () => {
    withSource();
    const r = await request(app).post('/api/org-truth/runs/dry-run').send({ sourceId: SRC, recipe, linkRules: [], mode: 'full' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rows: 2, entities: { Project: { total: 2 }, Person: { total: 1 } }, relations: { owner: 2 }, wouldClose: {}, issueCount: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('counts would-close entities for a named profile in full mode', async () => {
    withSource({ profile: { id: PROF, name: 'Projects' } });
    query.mockResolvedValue({ rows: [{ entityType: 'Project', canonicalKey: 'p-0' }] });
    const r = await request(app).post('/api/org-truth/runs/dry-run').send({ sourceId: SRC, recipe, mode: 'full', profileId: PROF });
    expect(r.body.wouldClose).toEqual({ Project: 1 });
    expect(query.mock.calls[0][1]).toEqual(['Projects']);
  });

  it('refuses a missing mode, a malformed or unknown profile, an unknown source', async () => {
    withSource();
    const noMode = await request(app).post('/api/org-truth/runs/dry-run').send({ sourceId: SRC, recipe });
    expect(noMode.status).toBe(400);
    expect(noMode.body).toEqual({ error: 'mode "undefined" is not one of full, delta.' });
    expect((await request(app).post('/api/org-truth/runs/dry-run').send({ sourceId: SRC, recipe, mode: 'full', profileId: 'x' })).status).toBe(400);
    const unknownProfile = await request(app).post('/api/org-truth/runs/dry-run').send({ sourceId: SRC, recipe, mode: 'full', profileId: PROF });
    expect(unknownProfile.status).toBe(404);
    expect(unknownProfile.body).toEqual({ error: 'Profile not found.' });
    const unknownSource = await request(app).post('/api/org-truth/runs/dry-run').send({ sourceId: PROF, recipe, mode: 'delta' });
    expect(unknownSource.status).toBe(404);
    expect(unknownSource.body).toEqual({ error: 'Source not found.' });
  });

  it('answers 400 with the sentences when the recipe does not fit the source', async () => {
    withSource();
    const r = await request(app).post('/api/org-truth/runs/dry-run').send({ sourceId: SRC, recipe: { ...recipe, entities: [{ type: 'T', nameColumn: 'Nope' }], relations: [] }, mode: 'delta' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'The recipe or link rules do not fit this source.', errors: ['Entity "T" nameColumn refers to column "Nope", which the source does not have.'] });
  });

  it('answers 400 when the stored file no longer parses', async () => {
    queryOne.mockResolvedValue({ id: SRC, content: Buffer.alloc(0) });
    const r = await request(app).post('/api/org-truth/runs/dry-run').send({ sourceId: SRC, recipe, mode: 'delta' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'The file is empty.' });
  });

  it('answers 400 for a body without anything in it', async () => {
    expect((await request(app).post('/api/org-truth/runs/dry-run')).status).toBe(400);
  });
});

describe('POST /org-truth/runs', () => {
  const stage = (opts = {}) => {
    const { source, profile, active } = { source: { id: SRC }, profile: { id: PROF, name: 'Projects', version: 2 }, ...opts };
    queryOne.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO "OrgImportRuns"')) return { id: RUN, status: 'queued' };
      if (sql.includes('JOIN "OrgImportProfiles"')) return active;
      if (sql.includes('FROM "OrgSources"')) return source;
      if (sql.includes('FROM "OrgImportProfiles"')) return profile;
      return undefined;
    });
  };

  it('answers 202 with the queued run and starts it in the background', async () => {
    stage();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const r = await request(app).post('/api/org-truth/runs').send({ sourceId: SRC, profileId: PROF, mode: 'delta' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ id: RUN, status: 'queued' });
    const insert = queryOne.mock.calls.find(([sql]) => sql.includes('INSERT INTO "OrgImportRuns"'))[1];
    expect(insert.slice(1)).toEqual([PROF, 2, SRC, 'delta', 'anonymous']);
    await vi.waitFor(() => expect(query.mock.calls.some(([sql, p]) => sql.startsWith('UPDATE "OrgImportRuns"') && p[0] === RUN)).toBe(true));
  });

  it('answers 409 with the busy run while one of the same profile is in progress', async () => {
    stage({ active: { id: 'busy' } });
    const r = await request(app).post('/api/org-truth/runs').send({ sourceId: SRC, profileId: PROF, mode: 'full' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Profile "Projects" already has a run in progress; wait for it to finish.', runId: 'busy' });
    expect(queryOne.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  it('refuses a bad mode, an unknown source, an unknown profile', async () => {
    stage();
    expect((await request(app).post('/api/org-truth/runs').send({ sourceId: SRC, profileId: PROF, mode: 'everything' })).status).toBe(400);
    stage({ source: undefined });
    expect((await request(app).post('/api/org-truth/runs').send({ sourceId: SRC, profileId: PROF, mode: 'full' })).body).toEqual({ error: 'Source not found.' });
    stage({ profile: undefined });
    const r = await request(app).post('/api/org-truth/runs').send({ sourceId: SRC, profileId: PROF, mode: 'full' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Profile not found.' });
  });
});

describe('GET /org-truth/runs', () => {
  it('lists the most recent runs with optional filters', async () => {
    query.mockResolvedValue({ rows: [{ id: RUN }] });
    expect((await request(app).get('/api/org-truth/runs')).body).toEqual([{ id: RUN }]);
    expect(query.mock.calls[0][1]).toEqual([null, null]);
    expect(query.mock.calls[0][0]).toContain(`LIMIT ${RUN_LIST_LIMIT}`);
    await request(app).get(`/api/org-truth/runs?sourceId=${SRC}&profileId=${PROF}`);
    expect(query.mock.calls[1][1]).toEqual([SRC, PROF]);
    await request(app).get(`/api/org-truth/runs?sourceId=&profileId=${PROF}`);
    expect(query.mock.calls[2][1]).toEqual([null, PROF]);
  });

  it('refuses a malformed filter', async () => {
    const r = await request(app).get('/api/org-truth/runs?profileId=1;drop');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'profileId is not a valid id.' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /org-truth/runs/:id', () => {
  it('returns one run, 404 when unknown or malformed', async () => {
    queryOne.mockImplementation(async (sql, p) => (p[0] === RUN ? { id: RUN, status: 'running' } : undefined));
    expect((await request(app).get(`/api/org-truth/runs/${RUN}`)).body).toEqual({ id: RUN, status: 'running' });
    expect((await request(app).get(`/api/org-truth/runs/${SRC}`)).status).toBe(404);
    const bad = await request(app).get('/api/org-truth/runs/abc');
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual({ error: 'Run not found.' });
  });
});

// ─── The whole flow through the composed router, on an in-memory store ──
function memoryDb() {
  const db = { sources: new Map(), profiles: new Map(), runs: new Map() };
  queryOne.mockImplementation(async (sql, p = []) => {
    if (sql.includes('INSERT INTO "OrgSources"')) {
      const row = { id: p[0], kind: p[1], displayName: p[2], fileName: p[3], mimeType: p[4], byteSize: p[5], content: p[7], observedAt: p[8] };
      db.sources.set(row.id, row);
      const { content: _omit, ...visible } = row;
      return visible;
    }
    if (sql.includes('FROM "OrgSources"')) return db.sources.get(p[0]);
    if (sql.includes('SELECT 1 AS "taken"')) return undefined;
    if (sql.includes('INSERT INTO "OrgImportProfiles"')) {
      const row = { id: p[0], name: p[1], version: 1, sourceKind: p[2], recipe: JSON.parse(p[3]), linkRules: JSON.parse(p[4]) };
      db.profiles.set(row.id, row);
      return row;
    }
    if (sql.includes('JOIN "OrgImportProfiles"')) return undefined;
    if (sql.includes('FROM "OrgImportProfiles"')) return db.profiles.get(p[0]);
    if (sql.includes('INSERT INTO "OrgImportRuns"')) {
      const row = { id: p[0], profileId: p[1], profileVersion: p[2], sourceId: p[3], mode: p[4], status: 'queued' };
      db.runs.set(row.id, row);
      return { ...row };
    }
    if (sql.includes('FROM "OrgImportRuns" WHERE "id"')) return db.runs.get(p[0]) && { ...db.runs.get(p[0]) };
    return undefined;
  });
  query.mockImplementation(async (sql, p = []) => {
    if (sql.startsWith('UPDATE "OrgImportRuns"')) {
      const names = [...sql.matchAll(/"(\w+)" = \$\d+/g)].map(m => m[1]);
      Object.assign(db.runs.get(p[0]), Object.fromEntries(names.map((n, i) => [n, p[i + 1]])));
    }
    return { rows: [], rowCount: 0 };
  });
  return db;
}

describe('upload → profile → dry-run → run, end to end', () => {
  it('ends in a completed run that handed its id to linking and queued the projection', async () => {
    memoryDb();
    const api = mountRouter(composed);

    const up = await request(api).post('/api/org-truth/sources').attach('file', Buffer.from(CSV), 'projects.csv');
    expect(up.status).toBe(201);
    expect(up.body.content).toBeUndefined();
    expect(up.body.columns.map(c => c.name)).toEqual(['Code', 'Project', 'Owner']);
    const sourceId = up.body.id;

    const dry = await request(api).post('/api/org-truth/runs/dry-run').send({ sourceId, recipe, linkRules: [], mode: 'full' });
    expect(dry.status).toBe(200);
    expect(dry.body.entities.Project.total).toBe(2);

    const prof = await request(api).post('/api/org-truth/profiles').send({ name: 'Projects', recipe, linkRules: [] });
    expect(prof.status).toBe(201);

    const started = await request(api).post('/api/org-truth/runs').send({ sourceId, profileId: prof.body.id, mode: 'full' });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe('queued');

    let run;
    await vi.waitFor(async () => {
      run = (await request(api).get(`/api/org-truth/runs/${started.body.id}`)).body;
      expect(run.status).toBe('completed');
    });
    expect(linkRun).toHaveBeenCalledWith(expect.objectContaining({ runId: started.body.id }));
    expect(enqueueRun).toHaveBeenCalledWith('org-truth', { instanceKey: 'org-truth' }, 'org-import', { awaitCompletion: true });
    expect(enqueueRun).toHaveBeenCalledWith('org-truth-principals', { instanceKey: 'org-truth-principals' }, 'org-import', { awaitCompletion: true });
    expect(JSON.parse(run.stats)).toMatchObject({ rows: 2, write: { entitiesInserted: 3, relationsInserted: 2 }, links: { runId: started.body.id } });
  });
});
