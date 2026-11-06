// AUTHORIZATION SECURITY REGRESSION SUITE — REST and MCP, end to end.
//
// Boots the real app against the contract-test PostgreSQL with sign-in ON and
// drives it as eight personas over a hand-specified fixture
// (test-utils/securityFixture.js). Only the token check and the auth
// configuration are replaced; every authorization decision, every SQL statement
// and the MCP transport are the real ones.
//
// What it holds the platform to (docs/architecture/mcp-authorization.md):
//   1. A context owner opens exactly what the fixture says — over REST (detail
//      pages by GUID) and over MCP (run_query per entity) — and the two agree.
//   2. Search, relation filters, relation columns, counts, groupings, name
//      lookups, changes and reports cannot reach past that scope.
//   3. Every MCP answer says whether authorization restricted it; a restricted
//      count is never presented as the organisation's total.
//   4. Positive controls: an admin sees what an owner may not, through the very
//      same probes — so a probe that returns nothing proves the scope, not a
//      broken query.
//
// Runs in the contract job AND as its own required check
// ("Security: authorization regression", .github/workflows/pr.yml).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { seedSecurityFixture, dropSecurityFixture, nameOf, FIXTURE_PREFIX } from '../test-utils/securityFixture.js';
import { resetContextOwnerSettingForTests } from '../src/auth/contextOwnerSetting.js';
import { clearOwnerAccessCache } from '../src/auth/ownerAccess/index.js';
import { registerReport } from '../src/reports/registry.js';

vi.mock('../src/config/authConfig.js', async (importOriginal) =>
  (await import('../test-utils/authConfigMock.js')).signInOnConfig(await importOriginal(), {
    'role-admin': ['*'],
    'role-asker': ['mcp.use', 'data.read', 'data.read.reports'],
    'role-nomcp': ['data.read', 'data.read.reports'],
  }));
// The bearer token IS the claims, base64url-encoded JSON. Signature checking is
// covered by middleware/jwtValidation.test.js; here the subject is what a
// verified caller may see.
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: (token, _key, _opts, cb) => {
      try { cb(null, JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))); } catch (e) { cb(e); }
    },
  },
}));

const SWITCHES = ['CONTEXT_OWNER_ACCESS', 'CONTEXT_OWNER_MCP', 'FEATURE_MCP_SERVER'];
const ENTITY_OF_KIND = { principal: 'account', identity: 'identity', resource: 'resource', context: 'context' };
const DETAIL_PATH = { principal: 'user', identity: 'identities', resource: 'resources', context: 'contexts' };
const OWNERS = ['carla', 'dave', 'bob', 'mia'];

let agent;
let pool;
let fx;
let unregisterAnalystReport;

const claimsFor = (persona) => {
  const roleOf = { admin: ['role-admin'], asker: ['role-asker'], nomcp: ['role-nomcp'] };
  const oid = roleOf[persona] ? randomUUID() : fx.id[persona];
  return { oid, roles: roleOf[persona] || [], tid: 'test-tenant', preferred_username: `${persona}@secfx.test` };
};
const token = (persona, { mcp = false } = {}) =>
  Buffer.from(JSON.stringify({ ...claimsFor(persona), scp: mcp ? 'Mcp.Read' : 'access' })).toString('base64url');

const restGet = (persona, path) => agent.get(path).set('Authorization', `Bearer ${token(persona)}`);
const rpc = (persona, method, params) => agent.post('/mcp')
  .set('Accept', 'application/json, text/event-stream')
  .set('Authorization', `Bearer ${token(persona, { mcp: true })}`)
  .send({ jsonrpc: '2.0', id: 1, method, params });
async function tool(persona, name, args = {}) {
  const res = await rpc(persona, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  return res.body.result;
}
const data = (result) => result.structuredContent;
const errorText = (result) => { expect(result.isError).toBe(true); return result.content[0].text; };

// run_query over the fixture only (an admin also sees other files' leftovers).
const fixtureQuery = (entity, extra = {}) => ({
  definition: { entity, conditions: [{ field: 'displayName', op: 'startsWith', value: FIXTURE_PREFIX }], columns: ['displayName'], ...extra },
  maxRows: 500,
});
const idsOf = (result) => new Set(data(result).rows.map(r => r.id));
const namesOf = (result) => data(result).rows.map(r => r.displayName);
const fixtureIds = (kind) => Object.entries(fx.id).filter(([k]) => kindOf(k) === kind).map(([, v]) => v);
const kindOf = (key) => {
  if (key === 'annPerson') return 'identity';
  if (key.startsWith('group') || key === 'appResource') return 'resource';
  if (key.startsWith('unit') || key === 'appX') return 'context';
  return 'principal';
};

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  fx = await seedSecurityFixture(pool);
  for (const key of SWITCHES) {
    await pool.query(
      `INSERT INTO "WorkerConfig" ("configKey","configValue") VALUES ($1,'true')
       ON CONFLICT ("configKey") DO UPDATE SET "configValue" = 'true'`, [key],
    );
  }
  resetContextOwnerSettingForTests();
  clearOwnerAccessCache();
  // A report an analyst saved: it reads everyone, including the outsider.
  unregisterAnalystReport = registerReport({
    name: 'secfx-analyst-report', displayName: 'Analyst report', description: 'everyone', form: 'list',
    columns: [{ key: 'displayName', label: 'Name' }],
    run: async () => ({ rows: [{ displayName: nameOf('olga'), _entity: { kind: 'user', id: fx.id.olga } }] }),
  });
});

afterAll(async () => {
  unregisterAnalystReport?.();
  await pool?.query(`DELETE FROM "WorkerConfig" WHERE "configKey" = ANY($1::text[])`, [SWITCHES]);
  await dropSecurityFixture(pool, fx);
  resetContextOwnerSettingForTests();
  clearOwnerAccessCache();
  await pool?.end();
  delete process.env.USE_SQL;
});

// ─── 1. One scope, two interfaces ─────────────────────────────────────────

describe('a context owner opens exactly the specified objects — over REST and over MCP alike', () => {
  for (const persona of OWNERS) {
    for (const kind of Object.keys(ENTITY_OF_KIND)) {
      it(`${persona} · ${kind}`, async () => {
        const expected = fx.expected[persona][kind];
        const rest = new Set();
        for (const id of fixtureIds(kind)) {
          const res = await restGet(persona, `/api/${DETAIL_PATH[kind]}/${id}`);
          expect([200, 403]).toContain(res.status);
          if (res.status === 200) rest.add(id);
        }
        const mcp = idsOf(await tool(persona, 'run_query', fixtureQuery(ENTITY_OF_KIND[kind])));
        expect([...rest].sort()).toEqual([...expected].sort());
        expect([...mcp].sort()).toEqual([...expected].sort());
      });
    }
  }

  it('positive control: an admin opens every fixture object over both', async () => {
    for (const kind of Object.keys(ENTITY_OF_KIND)) {
      for (const id of fixtureIds(kind)) expect((await restGet('admin', `/api/${DETAIL_PATH[kind]}/${id}`)).status).toBe(200);
      const mcp = idsOf(await tool('admin', 'run_query', fixtureQuery(ENTITY_OF_KIND[kind])));
      for (const id of fixtureIds(kind)) expect(mcp.has(id)).toBe(true);
    }
  });

  it('scopes do not bleed between owners asked one after another (no shared cache by mistake)', async () => {
    const q = fixtureQuery('account');
    const first = idsOf(await tool('carla', 'run_query', q));
    const between = idsOf(await tool('bob', 'run_query', q));
    const again = idsOf(await tool('carla', 'run_query', q));
    expect(again).toEqual(first);
    expect(between.has(fx.id.andy)).toBe(false);
    expect(first.has(fx.id.ben)).toBe(false);
  });
});

// ─── 2. Who may use MCP at all ─────────────────────────────────────────────

describe('who may use MCP', () => {
  const toolNames = async (persona) => {
    const res = await rpc(persona, 'tools/list', {});
    return res.status === 200 ? res.body.result.tools.map(t => t.name).sort() : res.status;
  };

  it('an owner gets the scoped tools; an asker and an admin get theirs', async () => {
    const all = ['describe_data_model', 'get_photos', 'list_reports', 'run_query', 'run_report', 'search', 'whoami'];
    expect(await toolNames('carla')).toEqual(all);
    expect(await toolNames('asker')).toEqual(all);
    expect(await toolNames('admin')).toEqual(all);
  });

  it('refuses the outsider (no role, answers for nothing) and a reader whose role lacks mcp.use', async () => {
    expect(await toolNames('olga')).toBe(403);
    expect(await toolNames('nomcp')).toBe(403);
  });

  it('refuses an owner once the MCP switch for owners is turned off, while REST still lets them in', async () => {
    await pool.query(`UPDATE "WorkerConfig" SET "configValue" = 'false' WHERE "configKey" = 'CONTEXT_OWNER_MCP'`);
    resetContextOwnerSettingForTests();
    try {
      expect(await toolNames('carla')).toBe(403);
      expect((await restGet('carla', `/api/contexts/${fx.id.unitA}`)).status).toBe(200);
    } finally {
      await pool.query(`UPDATE "WorkerConfig" SET "configValue" = 'true' WHERE "configKey" = 'CONTEXT_OWNER_MCP'`);
      resetContextOwnerSettingForTests();
    }
  });

  it('whoami tells the owner which contexts they answer for — and nothing about the rest', async () => {
    const me = data(await tool('mia', 'whoami'));
    expect(me.scope.restricted).toBe(true);
    expect(me.scope.contexts.map(c => c.name).sort()).toEqual([nameOf('appX'), nameOf('unitB')].sort());
  });
});

// ─── 3. Adversarial: alternative paths to data outside the scope ───────────

describe('known GUIDs and explicit filters on what lies outside', () => {
  it('a query for the outsider by her id returns nothing for an owner — and her for an admin', async () => {
    const q = { definition: { entity: 'user', conditions: [{ field: 'id', op: 'eq', value: fx.id.olga }], columns: ['displayName'] } };
    const owner = data(await tool('carla', 'run_query', q));
    expect(owner.rows).toEqual([]);
    expect(owner.scope.restricted).toBe(true);
    expect(namesOf(await tool('admin', 'run_query', q))).toEqual([nameOf('olga')]);
  });

  it('a REST detail read of the outsider\'s objects is refused, not answered empty', async () => {
    for (const path of [`/api/user/${fx.id.olga}`, `/api/resources/${fx.id.groupOutsider}`, `/api/contexts/${fx.id.unitOther}`]) {
      expect((await restGet('carla', path)).status).toBe(403);
    }
  });

  it('a filter naming an outsider exactly is told she exists but lies outside — her name and type only, no rows', async () => {
    // "Groups with Olga as a member": the Mixed group has her, and Carla's team holds it.
    const q = { definition: { entity: 'group', conditions: [{ relation: 'members', quantifier: 'some', conditions: [{ field: 'displayName', op: 'eq', value: nameOf('olga') }] }], columns: ['displayName'] } };
    const result = await tool('carla', 'run_query', q);
    const text = errorText(result);
    expect(text).toContain('exists in Identity Atlas, but lies outside the part you may see');
    expect(JSON.parse(text).outsideScope).toEqual([{ name: nameOf('olga'), type: 'User' }]);
    expect(text).not.toContain(fx.id.olga);
    expect(text).not.toContain('Secret department');
    expect(text).not.toContain(nameOf('groupMixed'));
    expect(namesOf(await tool('admin', 'run_query', q))).toContain(nameOf('groupMixed'));
  });

  it('a name that exists nowhere gets "not found / did you mean" — never "exists outside"', async () => {
    const q = { definition: { entity: 'user', conditions: [{ field: 'displayName', op: 'eq', value: `${FIXTURE_PREFIX} Nobody Atall` }], columns: ['displayName'] } };
    const body = JSON.parse(errorText(await tool('carla', 'run_query', q)));
    expect(body.error).toMatch(/Did you mean|could not find/);
    expect(body).not.toHaveProperty('outsideScope');
    expect(JSON.stringify(body)).not.toContain('exists in Identity Atlas');
  });

  it('a relation filter on an outsider\'s id (no name lookup to stop it) matches nothing', async () => {
    const q = { definition: { entity: 'group', conditions: [{ relation: 'members', quantifier: 'some', conditions: [{ field: 'id', op: 'eq', value: fx.id.olga }] }], columns: ['displayName'] } };
    expect(data(await tool('carla', 'run_query', q)).rows).toEqual([]);
    expect(namesOf(await tool('admin', 'run_query', q))).toContain(nameOf('groupMixed'));
  });

  it('a relation filter cannot test an outsider\'s attributes either', async () => {
    const q = { definition: { entity: 'group', conditions: [{ relation: 'members', quantifier: 'some', conditions: [{ field: 'department', op: 'eq', value: 'Secret department' }] }], columns: ['displayName'] } };
    expect(data(await tool('carla', 'run_query', q)).rows).toEqual([]);
    expect(data(await tool('admin', 'run_query', q)).rows.length).toBeGreaterThan(0);
  });

  it('"none" over a relation cannot be inverted into a probe: the outsider simply does not exist for it', async () => {
    // Groups WITHOUT Olga: for an owner every in-scope group qualifies, because Olga is out of reach.
    const q = { definition: { entity: 'group', conditions: [
      { field: 'displayName', op: 'startsWith', value: FIXTURE_PREFIX },
      { relation: 'members', quantifier: 'none', conditions: [{ field: 'id', op: 'eq', value: fx.id.olga }] },
    ], columns: ['displayName'] } };
    expect(idsOf(await tool('carla', 'run_query', q))).toEqual(new Set([fx.id.groupA, fx.id.groupA1, fx.id.groupShared, fx.id.groupMixed]));
    // The admin sees the difference: the Mixed group does have her.
    expect(idsOf(await tool('admin', 'run_query', q)).has(fx.id.groupMixed)).toBe(false);
  });
});

describe('relation columns, counts and groupings', () => {
  it('a held group\'s member list is complete by name, as in the app — but nothing more about the outsider', async () => {
    const q = { definition: { entity: 'group', conditions: [{ field: 'id', op: 'eq', value: fx.id.groupMixed }], columns: ['displayName', 'members.names', 'members.count'] } };
    const [mine] = data(await tool('carla', 'run_query', q)).rows;
    expect(mine['members.names']).toBe([nameOf('ann'), nameOf('olga')].sort().join(', '));
    expect(mine['members.count']).toBe(2);
    // The REST page lists the same holders, Olga marked not openable.
    const rest = (await restGet('carla', `/api/resources/${fx.id.groupMixed}/assignments`)).body;
    const restRows = Array.isArray(rest) ? rest : rest.data;
    expect(restRows.find(m => m.principalId === fx.id.olga)?.accessible).toBe(false);
    expect(restRows.find(m => m.principalId === fx.id.ann)?.accessible).toBe(true);
  });

  it('a group outside the scope is not listed at all, so its members are not either', async () => {
    const q = { definition: { entity: 'group', conditions: [{ field: 'id', op: 'eq', value: fx.id.groupOutsider }], columns: ['displayName', 'members.names'] } };
    expect(data(await tool('carla', 'run_query', q)).rows).toEqual([]);
  });

  it('a grouped count counts only what is in scope, and says the figures are restricted', async () => {
    const q = { definition: { entity: 'user', conditions: [{ field: 'displayName', op: 'startsWith', value: FIXTURE_PREFIX }], groupBy: 'department' } };
    const owner = data(await tool('carla', 'run_query', q));
    expect(owner.rows.map(r => r.department)).not.toContain('Secret department');
    expect(owner.rows.reduce((n, r) => n + r.count, 0)).toBe(fx.expected.carla.principal.size);
    expect(owner.scope.restricted).toBe(true);
    const admin = data(await tool('admin', 'run_query', q));
    expect(admin.rows.map(r => r.department)).toContain('Secret department');
    expect(admin.scope.restricted).toBe(false);
  });

  it('"how many users" — a restricted total is labelled as such and is the in-scope figure, not the organisation\'s', async () => {
    const q = { ...fixtureQuery('user'), maxRows: 1 };
    const owner = data(await tool('carla', 'run_query', q));
    expect(owner).toMatchObject({ truncated: true, total: fx.expected.carla.principal.size, rowCount: 1 });
    expect(owner.scope).toMatchObject({ restricted: true, basis: 'context-owner' });
    // Nothing in the answer gives away how many there are in all.
    expect(owner).not.toHaveProperty('totalAtLeast');
    expect(Object.values(owner.scope).some(v => typeof v === 'number')).toBe(false);
    const admin = data(await tool('admin', 'run_query', q));
    expect(admin.total).toBeGreaterThanOrEqual(10);
    expect(admin.scope.restricted).toBe(false);
  });

  it('a sub-unit\'s people are in the owner of the parent\'s scope, not in a sibling owner\'s', async () => {
    const q = { definition: { entity: 'user', conditions: [{ field: 'id', op: 'eq', value: fx.id.andy }], columns: ['displayName'] } };
    expect(namesOf(await tool('carla', 'run_query', q))).toEqual([nameOf('andy')]);
    expect(data(await tool('bob', 'run_query', q)).rows).toEqual([]);
  });

  it('an application owner sees its holders, and what they hold elsewhere by name only — it does not open', async () => {
    const hank = { definition: { entity: 'user', conditions: [{ field: 'id', op: 'eq', value: fx.id.hank }], columns: ['displayName', 'access.names'] } };
    const [row] = data(await tool('mia', 'run_query', hank)).rows;
    expect(row.displayName).toBe(nameOf('hank'));
    expect(row['access.names']).toContain(nameOf('groupHankOther'));
    const other = { definition: { entity: 'resource', conditions: [{ field: 'id', op: 'eq', value: fx.id.groupHankOther }], columns: ['displayName'] } };
    expect(data(await tool('mia', 'run_query', other)).rows).toEqual([]);
    expect(data(await tool('carla', 'run_query', hank)).rows).toEqual([]);
  });
});

describe('search, name lookups and the data model', () => {
  it('search never finds the outsider for an owner; the admin finds her', async () => {
    const owner = data(await tool('carla', 'search', { text: 'Olga Outsider', kinds: ['account', 'identity', 'group', 'resource', 'context'] }));
    expect(owner.matches.map(m => m.id)).not.toContain(fx.id.olga);
    expect(owner.matches.map(m => m.name).join(' ')).not.toContain('Outsider');
    expect(owner.scope.restricted).toBe(true);
    const admin = data(await tool('admin', 'search', { text: 'Olga Outsider', kinds: ['account'] }));
    expect(admin.matches.map(m => m.id)).toContain(fx.id.olga);
  });

  it('every openable search match is an object they may open', async () => {
    for (const persona of OWNERS) {
      const res = data(await tool(persona, 'search', { text: FIXTURE_PREFIX, kinds: ['account', 'identity', 'resource', 'context'] }));
      const allowed = new Set(Object.values(fx.expected[persona]).flatMap(s => [...s]));
      for (const m of res.matches.filter(x => x.accessible !== false)) expect(allowed.has(m.id)).toBe(true);
    }
  });

  it('searching an outsider\'s full name says she exists — accessible false, no id, link or attributes', async () => {
    const res = data(await tool('carla', 'search', { text: nameOf('olga'), kinds: ['account'] }));
    expect(res.matches).toEqual([
      { name: nameOf('olga'), type: 'User', entity: 'account', accessible: false, note: expect.stringContaining('outside the part you may see') },
    ]);
  });

  it('a context outside the scope is never confirmed by name', async () => {
    const res = data(await tool('carla', 'search', { text: nameOf('unitOther'), kinds: ['context'] }));
    expect(res.matches.map(m => m.name)).not.toContain(nameOf('unitOther'));
    expect(res.matches.every(m => m.accessible === true && fx.expected.carla.context.has(m.id))).toBe(true);
  });

  it('"did you mean" offers no names from outside the scope', async () => {
    const q = { definition: { entity: 'user', conditions: [{ field: 'displayName', op: 'eq', value: 'SecFx Olga Outsidr' }], columns: ['displayName'] } };
    const text = errorText(await tool('carla', 'run_query', q));
    expect(text).not.toContain(fx.id.olga);
    expect(text).not.toContain(nameOf('olga'));
  });

  it('the data-model reference names no record of the organisation', async () => {
    const result = await tool('carla', 'describe_data_model');
    expect(result.content[0].text).toContain('Your scope:');
    expect(result.content[0].text).not.toContain('Olga');
  });

  it('comparing with a reference record is refused for an owner (it would read outside the scope)', async () => {
    const q = { definition: { entity: 'user', conditions: [{ type: 'compare', relation: 'memberOf', measure: 'containsAll', reference: { entity: 'user', name: nameOf('olga') } }], columns: ['displayName'] } };
    const text = errorText(await tool('carla', 'run_query', q));
    expect(text).not.toContain(fx.id.olga);
  });
});

describe('changes over time', () => {
  it('an owner sees only changes about an account or a resource in scope', async () => {
    const q = { definition: { entity: 'change', conditions: [], columns: ['displayName', 'account.displayName', 'resource.displayName'] }, maxRows: 500 };
    const owner = data(await tool('carla', 'run_query', q)).rows;
    expect(owner.length).toBeGreaterThan(0);
    for (const row of owner) expect(row.displayName).not.toContain(nameOf('groupOutsider'));
    const admin = data(await tool('admin', 'run_query', q)).rows;
    expect(admin.some(r => r.displayName.includes(nameOf('groupOutsider')))).toBe(true);
  });
});

describe('reports', () => {
  it('an owner is offered only the two reports of their own contexts', async () => {
    const list = data(await tool('carla', 'list_reports'));
    expect(list.reports.map(r => r.name).sort()).toEqual(['application-access-review', 'unit-members']);
  });

  it('a report an analyst saved — which reads everyone — answers an owner as if it did not exist', async () => {
    const owner = errorText(await tool('carla', 'run_report', { name: 'secfx-analyst-report' }));
    expect(owner).toContain('No report with that name');
    expect(owner).not.toContain('Olga');
    const admin = data(await tool('admin', 'run_report', { name: 'secfx-analyst-report' }));
    expect(admin.rows[0].displayName).toBe(nameOf('olga'));
  });

  it('the unit report runs on the owner\'s own unit, by id, through MCP as through the REST download', async () => {
    const mcp = await tool('carla', 'run_report', { name: 'unit-members', parameters: { contexts: [fx.id.unitA] } });
    expect(mcp.isError).toBeUndefined();
    expect(data(mcp).scope.restricted).toBe(true);
    expect((await restGet('carla', `/api/reports/unit-members/export?contexts=${fx.id.unitA}`)).status).toBe(200);
  });

  it.each([
    ['another owner\'s unit', (f) => ({ contexts: [f.id.unitB] })],
    ['the unit no one in the test owns', (f) => ({ contexts: [f.id.unitOther] })],
    ['a unit named instead of given by id', () => ({ contexts: [nameOf('unitA')] })],
  ])('refuses %s through MCP and through REST', async (_label, params) => {
    const p = params(fx);
    errorText(await tool('carla', 'run_report', { name: 'unit-members', parameters: p }));
    const res = await restGet('carla', `/api/reports/unit-members/export?contexts=${encodeURIComponent(p.contexts[0])}`);
    expect(res.status).toBe(403);
  });
});

describe('REST paths an owner may not take at all', () => {
  it.each([
    ['/api/contexts'],
    ['/api/reports/orphaned-accounts/rows'],
    ['/api/reports/secfx-analyst-report/rows'],
    ['/api/admin/context-owner-access'],
  ])('%s is refused for an owner', async (path) => {
    expect((await restGet('carla', path)).status).toBe(403);
  });

  it('an unanchored matrix query is refused', async () => {
    const res = await agent.post('/api/matrix/data').set('Authorization', `Bearer ${token('carla')}`)
      .send({ filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });
    expect(res.status).toBe(403);
  });
});

describe('profile photos', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
  beforeAll(async () => {
    for (const k of ['ann', 'olga', 'carla']) {
      await pool.query(`UPDATE "Principals" SET "photo" = $2, "photoContentType" = 'image/png' WHERE "id" = $1`, [fx.id[k], PNG]);
    }
  });

  it('an owner gets the photos of people they may open, and their own — never the outsider\'s', async () => {
    const r = await tool('carla', 'get_photos', { ids: [fx.id.ann, fx.id.carla, fx.id.olga] });
    const body = data(r);
    expect(body.photos.map(p => p.id).sort()).toEqual([fx.id.ann, fx.id.carla].sort());
    expect(body.notAvailable).toEqual([fx.id.olga]);
    expect(r.content.filter(c => c.type === 'image')).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain(nameOf('olga'));
  });

  it('the REST detail page shows the photo of a team member to the owner, as get_photos does', async () => {
    const res = await restGet('carla', `/api/user/${fx.id.ann}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('data:image/png;base64,');
  });

  it('positive control: an admin gets the outsider\'s photo', async () => {
    expect(data(await tool('admin', 'get_photos', { ids: [fx.id.olga] })).photos.map(p => p.id)).toEqual([fx.id.olga]);
  });
});

describe('errors reveal nothing protected', () => {
  it('an invalid definition about the outsider echoes no record data', async () => {
    const q = { definition: { entity: 'user', conditions: [{ field: 'id', op: 'eq', value: fx.id.olga }, { field: 'noSuchField', op: 'eq', value: 'x' }] } };
    const result = await tool('carla', 'run_query', q);
    expect(JSON.stringify(result)).not.toContain(nameOf('olga'));
    expect(JSON.stringify(result)).not.toContain('Secret department');
  });
});
