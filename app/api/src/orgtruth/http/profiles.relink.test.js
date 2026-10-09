// POST /org-truth/profiles/:id/relink and /rename-type — the two "change it
// after the fact" routes. Own file (own mocks of the stores and the run
// starter) so profiles.test.js keeps exercising getProfile through the db mock.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));
vi.mock('../import/profileStore.js', async (orig) => ({ ...(await orig()), getProfile: vi.fn() }));
vi.mock('../import/sourceStore.js', () => ({ getSource: vi.fn() }));
vi.mock('../import/runImport.js', () => ({ createImportRun: vi.fn(), findActiveRun: vi.fn(), startImportRun: vi.fn() }));
vi.mock('../projection/refresh.js', () => ({ refreshProjections: vi.fn() }));

import { query, queryOne, tx } from '../../db/connection.js';
import { getProfile } from '../import/profileStore.js';
import { getSource } from '../import/sourceStore.js';
import { createImportRun, findActiveRun, startImportRun } from '../import/runImport.js';
import { refreshProjections } from '../projection/refresh.js';
import router, { renameInRecipe, renameInRules } from './profiles.js';

const app = mountRouterAs(router, () => ({ preferred_username: 'ana@fortigi.nl' }));
const ID = '6f1c1c2e-8d3b-4a8e-9c1d-2b3c4d5e6f70';
const SRC = 'a0000000-0000-4000-8000-0000000000aa';
const RUN = 'c0000000-0000-4000-8000-0000000000cc';

const fuzzy = (attribute) => [{ attribute, targetField: 'displayName', type: 'fuzzy', weight: 100 }];
// A normalised profile as stored: Uren rows link to the FortigiTeam list via klant.
const URen = () => ({
  id: ID, name: 'Uren', version: 4, sourceKind: 'list',
  recipe: {
    version: 1,
    entities: [
      { type: 'Uren', keyColumn: 'Id', nameColumn: 'Omschrijving', attributes: [{ column: 'Klant', name: 'klant' }, { column: 'Wie', name: 'medewerker' }] },
      { type: 'Persoon', keyColumn: 'Wie', nameColumn: 'Wie', attributes: [] },
    ],
    relations: [{ predicate: 'geboektDoor', from: 'Uren', to: 'Persoon' }],
  },
  linkRules: [
    { entityType: 'Uren', targetType: 'OrgEntity', targetEntityType: 'FortigiTeam', via: 'klant', name: 'Uren → FortigiTeam via klant', threshold: 60, signals: fuzzy('klant') },
  ],
});

const PRE = '/api/org-truth/profiles';

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const m of [query, queryOne, getProfile, getSource, createImportRun, findActiveRun, startImportRun, refreshProjections]) m.mockReset();
  tx.mockClear();
  queryOne.mockResolvedValue(undefined); // feature flag: env decides; no rows otherwise
  getProfile.mockImplementation(async (id) => (id === ID ? URen() : undefined));
  refreshProjections.mockResolvedValue(undefined);
});

describe('gates', () => {
  it.each(['relink', 'rename-type'])('POST /profiles/:id/%s needs data.write.contexts and is behind the feature flag', async (action) => {
    const denied = await request(app).post(`${PRE}/${ID}/${action}`).set('x-deny', 'data.write.contexts').send({});
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ denied: 'data.write.contexts' });
    // data.read alone is not what this route asks for
    expect((await request(app).post(`${PRE}/nope/${action}`).set('x-deny', 'data.read').send({})).status).toBe(404);
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).post(`${PRE}/${ID}/${action}`).send({})).status).toBe(404);
    expect(getProfile).not.toHaveBeenCalledWith(ID);
  });
});

describe('POST /org-truth/profiles/:id/relink', () => {
  const NEW_RULES = [{ entityType: 'Uren', targetType: 'OrgEntity', targetEntityType: 'Klant', via: 'klant', signals: fuzzy('klant') }];
  const lastRun = (sourceId = SRC) => queryOne.mockImplementation(async (sql) => (sql.includes('FROM "OrgImportRuns"') && sourceId ? { sourceId } : undefined));
  const insertCalls = () => queryOne.mock.calls.filter(([sql]) => sql.includes('INSERT INTO "OrgImportProfiles"'));

  it('404 for an unknown profile', async () => {
    const r = await request(app).post(`${PRE}/b0000000-0000-4000-8000-000000000000/relink`).send({ linkRules: NEW_RULES });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Profile not found.' });
    expect(insertCalls()).toEqual([]);
  });

  it('400 with the sentences for invalid rules, validated against the profile\'s recipe', async () => {
    const r = await request(app).post(`${PRE}/${ID}/relink`).send({ linkRules: [{ ...NEW_RULES[0], entityType: 'Ghost' }, { ...NEW_RULES[0], targetType: 'Principal', signals: fuzzy('medewerker') }] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: 'The link rules are not valid.',
      errors: [
        'Link rule 1 is for entity type "Ghost", which the recipe does not define.',
        'Link rule 2 ("Uren") targetEntityType names the entity type of another list and only goes with targetType OrgEntity.',
      ],
    });
    expect(insertCalls()).toEqual([]);
    expect(createImportRun).not.toHaveBeenCalled();
  });

  it('409 when the profile never ran, before saving anything', async () => {
    lastRun(null);
    const r = await request(app).post(`${PRE}/${ID}/relink`).send({ linkRules: NEW_RULES });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('This profile has not imported a source yet; run the import wizard first.');
    expect(insertCalls()).toEqual([]);
  });

  it('409 with the run id while a run is in progress, before saving anything', async () => {
    lastRun();
    findActiveRun.mockResolvedValue({ id: RUN });
    const r = await request(app).post(`${PRE}/${ID}/relink`).send({ linkRules: NEW_RULES });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Profile "Uren" already has a run in progress; wait for it to finish.', runId: RUN });
    expect(findActiveRun).toHaveBeenCalledWith('Uren');
    expect(insertCalls()).toEqual([]);
    expect(startImportRun).not.toHaveBeenCalled();
  });

  it('202: saves the next version with the same recipe and the posted rules, and starts a delta run on the last source', async () => {
    const profile = { id: 'd0000000-0000-4000-8000-0000000000dd', name: 'Uren', version: 5 };
    const source = { id: SRC, kind: 'list' };
    const run = { id: RUN, mode: 'delta' };
    queryOne.mockImplementation(async (sql) => {
      if (sql.includes('FROM "OrgImportRuns"')) return { sourceId: SRC };
      if (sql.includes('INSERT INTO "OrgImportProfiles"')) return profile;
      return undefined;
    });
    findActiveRun.mockResolvedValue(null);
    getSource.mockResolvedValue(source);
    createImportRun.mockResolvedValue(run);

    const r = await request(app).post(`${PRE}/${ID}/relink`).send({ linkRules: NEW_RULES });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ profile, run });

    // the last run is looked up across every version of the profile name
    const [lastSql, lastParams] = queryOne.mock.calls.find(([sql]) => sql.includes('FROM "OrgImportRuns"'));
    expect(lastSql).toMatch(/WHERE p\.name = \$1 ORDER BY r\."createdAt" DESC LIMIT 1/);
    expect(lastParams).toEqual(['Uren']);

    expect(insertCalls()).toHaveLength(1);
    const [sql, params] = insertCalls()[0];
    expect(sql).toMatch(/COALESCE\(MAX\("version"\), 0\) \+ 1/);
    const [, name, sourceKind, recipeJson, rulesJson, actor] = params;
    expect([name, sourceKind, actor]).toEqual(['Uren', 'list', 'ana@fortigi.nl']);
    expect(JSON.parse(recipeJson)).toEqual(URen().recipe);
    expect(JSON.parse(rulesJson)).toEqual([{
      entityType: 'Uren', targetType: 'OrgEntity', targetEntityType: 'Klant', via: 'klant',
      name: 'Uren → Klant via klant', threshold: 50,
      signals: [{ name: 'klant→displayName', attribute: 'klant', targetField: 'displayName', type: 'fuzzy', weight: 100, order: 0 }],
    }]);

    expect(getSource).toHaveBeenCalledWith(SRC);
    expect(createImportRun).toHaveBeenCalledWith({ source, profile, mode: 'delta', triggeredBy: 'ana@fortigi.nl' });
    expect(startImportRun).toHaveBeenCalledWith(RUN);
  });

  it('409 when the last run\'s source is gone, without starting a run', async () => {
    lastRun();
    findActiveRun.mockResolvedValue(null);
    getSource.mockResolvedValue(undefined);
    const r = await request(app).post(`${PRE}/${ID}/relink`).send({ linkRules: NEW_RULES });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('The source of the last run no longer exists; upload the list again.');
    expect(createImportRun).not.toHaveBeenCalled();
    expect(startImportRun).not.toHaveBeenCalled();
  });
});

describe('renameInRecipe / renameInRules', () => {
  it('renames the entity and both ends of its relations, leaving the rest alone', () => {
    const recipe = {
      version: 1,
      entities: [{ type: 'Uren', nameColumn: 'A' }, { type: 'Persoon', nameColumn: 'B' }],
      relations: [{ predicate: 'p', from: 'Uren', to: 'Persoon' }, { predicate: 'q', from: 'Persoon', to: 'Uren' }],
    };
    expect(renameInRecipe(recipe, 'Uren', 'Urenregel')).toEqual({
      version: 1,
      entities: [{ type: 'Urenregel', nameColumn: 'A' }, { type: 'Persoon', nameColumn: 'B' }],
      relations: [{ predicate: 'p', from: 'Urenregel', to: 'Persoon' }, { predicate: 'q', from: 'Persoon', to: 'Urenregel' }],
    });
    expect(recipe.entities[0].type).toBe('Uren');
    expect(renameInRecipe({ version: 1, entities: [] }, 'Uren', 'X').relations).toEqual([]);
  });

  it('renames entityType and targetEntityType, drops the derived name, and adds no targetEntityType', () => {
    const rules = [
      { entityType: 'Uren', targetType: 'OrgEntity', targetEntityType: 'Team', name: 'old' },
      { entityType: 'Project', targetType: 'OrgEntity', targetEntityType: 'Uren', name: 'old' },
      { entityType: 'Project', targetType: 'Principal', name: 'old' },
    ];
    const out = renameInRules(rules, 'Uren', 'Urenregel');
    expect(out).toEqual([
      { entityType: 'Urenregel', targetType: 'OrgEntity', targetEntityType: 'Team', name: undefined },
      { entityType: 'Project', targetType: 'OrgEntity', targetEntityType: 'Urenregel', name: undefined },
      { entityType: 'Project', targetType: 'Principal', name: undefined },
    ]);
    expect(out[2]).not.toHaveProperty('targetEntityType');
    expect(renameInRules(undefined, 'a', 'b')).toEqual([]);
  });

  it('for another profile only the references follow, not its own type of the same name', () => {
    const other = [
      { entityType: 'Uren', targetType: 'Principal' },                                   // its own "Uren": untouched
      { entityType: 'Project', targetType: 'OrgEntity', targetEntityType: 'Uren' },      // a reference: follows
    ];
    expect(renameInRules(other, 'Uren', 'Urenregel', { ownType: false }).map(r => [r.entityType, r.targetEntityType ?? null]))
      .toEqual([['Uren', null], ['Project', 'Urenregel']]);
  });
});

describe('POST /org-truth/profiles/:id/rename-type', () => {
  // Latest versions of the OTHER profiles: one points at FortigiTeam, one does not.
  const POINTS = {
    id: 'e0000000-0000-4000-8000-000000000001', name: 'Projecten', version: 2, sourceKind: 'list',
    recipe: { version: 1, entities: [{ type: 'Project', keyColumn: 'C', nameColumn: 'C', attributes: [{ column: 'K', name: 'klant' }] }], relations: [] },
    linkRules: [{ entityType: 'Project', targetType: 'OrgEntity', targetEntityType: 'FortigiTeam', via: 'klant', name: 'Project → FortigiTeam via klant', threshold: 60, signals: fuzzy('klant') }],
  };
  const UNRELATED = {
    id: 'e0000000-0000-4000-8000-000000000002', name: 'Kosten', version: 1, sourceKind: 'list',
    recipe: { version: 1, entities: [{ type: 'Kost', keyColumn: 'C', nameColumn: 'C', attributes: [] }], relations: [] },
    linkRules: [{ entityType: 'Kost', targetType: 'OrgEntity', targetEntityType: 'Uren', via: 'displayName', name: 'Kost → Uren via displayName', threshold: 60, signals: fuzzy('displayName') }],
  };
  const TEAM = {
    id: 'e0000000-0000-4000-8000-000000000003', name: 'Teams', version: 7, sourceKind: 'list',
    recipe: { version: 1, entities: [{ type: 'FortigiTeam', keyColumn: 'T', nameColumn: 'T', attributes: [] }], relations: [] },
    linkRules: [],
  };

  let client;
  function stageTx({ others = [POINTS, UNRELATED], rowCount = 12 } = {}) {
    let version = 100;
    client = {
      query: vi.fn(async (sql, params) => {
        if (sql.includes('UPDATE "OrgEntities"')) return { rowCount };
        if (sql.includes('INSERT INTO "OrgImportProfiles"')) return { rows: [{ id: `v${version}`, name: params[1], version: version++ }] };
        if (sql.includes('FROM "OrgImportProfiles" p')) return { rows: others };
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    tx.mockImplementationOnce(async (fn) => fn(client));
  }
  const inserts = () => client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO "OrgImportProfiles"'));
  const post = (body, id = ID) => request(app).post(`${PRE}/${id}/rename-type`).send(body);

  it('404 for an unknown profile', async () => {
    const r = await post({ from: 'Uren', to: 'Urenregel' }, 'b0000000-0000-4000-8000-000000000000');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Profile not found.' });
    expect(tx).not.toHaveBeenCalled();
  });

  it('400 for a type the profile does not define (another profile\'s type counts as unknown)', async () => {
    for (const from of ['FortigiTeam', '', undefined]) {
      const r = await post({ from, to: 'Klant' });
      expect(r.status, String(from)).toBe(400);
      expect(r.body.error).toBe(`Profile "Uren" has no entity type "${from ?? ''}".`);
    }
    expect(tx).not.toHaveBeenCalled();
  });

  it('400 for a new name that does not start with a letter or digit, is too long, or has other characters', async () => {
    const msg = 'The new name must start with a letter or digit and be at most 64 letters, digits, spaces, _ or -.';
    for (const to of ['', '   ', '-Uren', '_x', 'Uren/2', 'a'.repeat(65), 'Uren.regel']) {
      const r = await post({ from: 'Uren', to });
      expect(r.status, to).toBe(400);
      expect(r.body).toEqual({ error: msg });
    }
    // 64 characters, digits, spaces, _ and - and letters with accents are fine
    queryOne.mockImplementation(async (sql) => (sql.includes('FROM "OrgEntities"') ? { t: 1 } : undefined)); // taken: stops before the tx
    for (const to of ['a'.repeat(64), '2026 Uren_regel-x', 'Uurrégel']) {
      expect((await post({ from: 'Uren', to })).status, to).toBe(409);
    }
    expect(tx).not.toHaveBeenCalled();
  });

  it('400 when the new name equals the old one, after trimming', async () => {
    const r = await post({ from: ' Uren ', to: 'Uren  ' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'The new name is the same as the old one.' });
    expect(tx).not.toHaveBeenCalled();
  });

  it('409 when entities of that name already exist anywhere', async () => {
    queryOne.mockImplementation(async (sql, params) => (sql.includes('FROM "OrgEntities"') && params[0] === 'Persoon' ? { t: 1 } : undefined));
    const r = await post({ from: 'Uren', to: 'Persoon' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'An entity type "Persoon" already exists; pick another name.' });
    expect(tx).not.toHaveBeenCalled();
    expect(refreshProjections).not.toHaveBeenCalled();
  });

  it('200: in one transaction renames the profile\'s entities, versions this profile and only the profiles that point at the type', async () => {
    stageTx();
    getProfile.mockImplementation(async (id) => (id === TEAM.id ? TEAM : undefined));

    const ok = await post({ from: 'FortigiTeam', to: ' Klant ' }, TEAM.id);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ profile: { id: 'v100', name: 'Teams', version: 100 }, renamedEntities: 12, otherProfiles: ['Projecten'] });
    expect(tx).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled(); // every write went through the transaction's client

    const [updSql, updParams] = client.query.mock.calls[0];
    expect(updSql).toMatch(/UPDATE "OrgEntities" SET "entityType" = \$1\s+WHERE "entityType" = \$2 AND "profileId" IN \(SELECT id FROM "OrgImportProfiles" WHERE name = \$3\)/);
    expect(updParams).toEqual(['Klant', 'FortigiTeam', 'Teams']);

    const [othersSql, othersParams] = client.query.mock.calls.find(([sql]) => sql.includes('FROM "OrgImportProfiles" p'));
    expect(othersSql).toMatch(/p\.name <> \$1 AND p\.version = \(SELECT MAX\(v\.version\)/);
    expect(othersParams).toEqual(['Teams']);

    const ins = inserts();
    expect(ins.map(([, p]) => p[1])).toEqual(['Teams', 'Projecten']);
    const [own, other] = ins.map(([, p]) => ({ sourceKind: p[2], recipe: JSON.parse(p[3]), rules: JSON.parse(p[4]), actor: p[5] }));
    expect(own.recipe.entities.map(e => e.type)).toEqual(['Klant']);
    expect(own.rules).toEqual([]);
    expect(own.actor).toBe('ana@fortigi.nl');
    // the other profile keeps its recipe; its rule now points at Klant and is renamed after it
    expect(other.recipe).toEqual(POINTS.recipe);
    expect(other.rules).toEqual([{
      entityType: 'Project', targetType: 'OrgEntity', targetEntityType: 'Klant', via: 'klant',
      name: 'Project → Klant via klant', threshold: 60,
      signals: [{ name: 'klant→displayName', attribute: 'klant', targetField: 'displayName', type: 'fuzzy', weight: 100, order: 0 }],
    }]);

    expect(refreshProjections).toHaveBeenCalledWith('type-rename');
  });

  it('renames the type in its own recipe, relations and rules, and versions no other profile when none points at it', async () => {
    stageTx({ others: [POINTS, TEAM], rowCount: null }); // a driver without rowCount reads as 0
    const r = await post({ from: 'Uren', to: 'Urenregel' });
    expect(r.status).toBe(200);
    expect(r.body.otherProfiles).toEqual([]);
    expect(r.body.renamedEntities).toBe(0);
    const ins = inserts();
    expect(ins).toHaveLength(1);
    const recipe = JSON.parse(ins[0][1][3]);
    expect(recipe.entities.map(e => e.type)).toEqual(['Urenregel', 'Persoon']);
    expect(recipe.relations).toEqual([{ predicate: 'geboektDoor', from: 'Urenregel', to: 'Persoon' }]);
    const [rule] = JSON.parse(ins[0][1][4]);
    expect(rule).toMatchObject({ entityType: 'Urenregel', targetEntityType: 'FortigiTeam', name: 'Urenregel → FortigiTeam via klant' });
  });

  it('answers 200 even when the projection refresh fails afterwards, and logs it', async () => {
    stageTx({ others: [] });
    refreshProjections.mockRejectedValue(new Error('plugin down'));
    const r = await post({ from: 'Uren', to: 'Urenregel' });
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith('org-truth: projection refresh after rename failed:', 'plugin down'));
  });

  it('500 when the transaction fails, without refreshing', async () => {
    tx.mockImplementationOnce(async () => { throw new Error('deadlock'); });
    const r = await post({ from: 'Uren', to: 'Urenregel' });
    expect(r.status).toBe(500);
    expect(refreshProjections).not.toHaveBeenCalled();
  });
});
