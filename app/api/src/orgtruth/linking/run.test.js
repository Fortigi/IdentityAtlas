import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { query } from '../../db/connection.js';
import { linkRun, upsertParams, UPSERT_CHUNK } from './run.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const rules = [{
  entityType: 'Person', targetType: 'Principal', threshold: 80,
  signals: [{ name: 'email', attribute: 'email', targetField: 'email', type: 'exact', weight: 90, order: 0 }],
}];

const entities = [
  { id: 'e1', entityType: 'Person', displayName: 'Ann', canonicalKey: 'ann', attributes: { email: 'ann@contoso.com' } },
  { id: 'e2', entityType: 'Person', displayName: 'Bob', canonicalKey: 'bob', attributes: '{"email":"bob@contoso.com"}' },
  { id: 'e3', entityType: 'Person', displayName: 'Cas', canonicalKey: 'cas', attributes: null },
  { id: 'p1', entityType: 'Project', displayName: 'Atlas', canonicalKey: 'atlas', attributes: {} },
];
const principals = [
  { id: 'u1', displayName: 'Ann', email: 'ann@contoso.com', principalType: 'User' },
  { id: 'u2', displayName: 'Bob', email: 'bob@contoso.com', principalType: 'User' },
];

// Route the SQL-blind mock by statement.
function stage({ existing = [], ents = entities } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM "OrgEntities"')) return { rows: ents };
    if (sql.includes('FROM "Principals"')) return { rows: principals };
    if (sql.startsWith('SELECT') && sql.includes('FROM "OrgLinks"')) return { rows: existing };
    return { rows: [], rowCount: 0 };
  });
}
const callsMatching = (re) => query.mock.calls.filter(([sql]) => re.test(sql));

beforeEach(() => { query.mockReset(); });

describe('linkRun', () => {
  it('reads the open entities of the run and writes accepted links in one upsert', async () => {
    stage();
    const log = vi.fn();
    const out = await linkRun({ runId: RUN, profile: { linkRules: rules }, log });
    expect(out).toEqual({ runId: RUN, linked: 2, proposed: 0, ambiguous: 0, none: 0, rejected: 0, empty: 1 }); // Cas has no e-mail

    const [entSql, entParams] = callsMatching(/FROM "OrgEntities"/)[0];
    expect(entSql).toMatch(/"runId" = \$1 AND "validTo" IS NULL/);
    expect(entParams).toEqual([RUN]);

    const [, existingParams] = callsMatching(/FROM "OrgLinks" WHERE "orgEntityId" = ANY/)[0];
    expect(existingParams).toEqual([['e1', 'e2', 'e3']]); // the Project has no rule

    const upserts = callsMatching(/INSERT INTO "OrgLinks"/);
    expect(upserts).toHaveLength(1);
    const [sql, params] = upserts[0];
    expect(sql).toMatch(/WHERE "OrgLinks"\."analystOverride" IS NULL/);
    expect(sql).toContain(`ON CONFLICT ("orgEntityId", "targetType", "targetId", (COALESCE("via", ''))) DO UPDATE`);
    expect(params[1]).toEqual(['e1', 'e2']);
    expect(params[3]).toEqual(['u1', 'u2']);
    expect(params[8]).toEqual(['email', 'email']);               // via: the rule's attribute
    expect(params[9]).toEqual(['ann@contoso.com', 'bob@contoso.com']); // the value that was linked
    expect(params[10]).toEqual(['accepted', 'accepted']);
    expect(params[11]).toBe(RUN);
    expect(callsMatching(/^UPDATE "OrgLinks"/)).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('linking Person: 3 entities scored');
    expect(log).toHaveBeenCalledWith('linking: 2 linked, 0 proposed, 0 ambiguous, 0 none, 0 stale links rejected');
  });

  it('override precedence on re-run: a confirmed link is untouched, a stale one rejected', async () => {
    stage({
      existing: [
        { id: 'l1', orgEntityId: 'e1', targetType: 'Principal', targetId: 'u9', status: 'accepted', analystOverride: 'confirmed' },
        { id: 'l2', orgEntityId: 'e2', targetType: 'Principal', targetId: 'u7', status: 'accepted', analystOverride: null },
      ],
    });
    const out = await linkRun({ runId: RUN, profile: { linkRules: rules } });
    expect(out).toMatchObject({ linked: 2, none: 0, empty: 1, rejected: 1 });
    const [, params] = callsMatching(/INSERT INTO "OrgLinks"/)[0];
    expect(params[1]).toEqual(['e2']);               // nothing written for the pinned e1
    const [rejSql, rejParams] = callsMatching(/^UPDATE "OrgLinks"/)[0];
    expect(rejSql).toMatch(/"analystOverride" IS NULL/);
    expect(rejParams).toEqual([['l2']]);
  });

  it('the whitelist: a stored rule naming a field outside LINK_TARGETS never reaches SQL', async () => {
    stage();
    const bad = [{ ...rules[0], signals: [{ ...rules[0].signals[0], targetField: 'passwordHash", "x' }] }];
    const out = await linkRun({ runId: RUN, profile: { linkRules: bad } });
    const [sql] = callsMatching(/FROM "Principals"/)[0];
    expect(sql).toBe('SELECT "id", "displayName", "principalType" FROM "Principals" WHERE "deletedAt" IS NULL AND ("principalType" IS NULL OR "principalType" <> ALL($1::text[]))');
    expect(out).toMatchObject({ linked: 0, none: 2, empty: 1 });
  });

  it('accepts linkRules as a JSONB string from a raw profile row', async () => {
    stage();
    const out = await linkRun({ runId: RUN, profile: { linkRules: JSON.stringify(rules) } });
    expect(out.linked).toBe(2);
  });

  it('writes nothing and reads no targets when there are no rules', async () => {
    stage();
    expect(await linkRun({ runId: RUN, profile: { recipe: null, linkRules: [] } }))
      .toEqual({ runId: RUN, linked: 0, proposed: 0, ambiguous: 0, none: 0, rejected: 0 });
    expect(await linkRun({ runId: RUN, profile: null })).toMatchObject({ linked: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('opens no transaction when the run has no entity of a ruled type', async () => {
    stage({ ents: [entities[3]] });
    expect(await linkRun({ runId: RUN, profile: { linkRules: rules } })).toMatchObject({ linked: 0, none: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('splits a large write into chunks', async () => {
    const many = Array.from({ length: UPSERT_CHUNK + 1 }, (_, i) => ({
      id: `e${i}`, entityType: 'Person', displayName: `P${i}`, canonicalKey: `p${i}`, attributes: { email: 'ann@contoso.com' },
    }));
    stage({ ents: many });
    await linkRun({ runId: RUN, profile: { linkRules: rules } });
    const upserts = callsMatching(/INSERT INTO "OrgLinks"/);
    expect(upserts.map(([, p]) => p[1].length)).toEqual([UPSERT_CHUNK, 1]);
  });
});

describe('upsertParams', () => {
  it('builds one array per column, a fresh uuid per row, and the run id last', () => {
    const p = upsertParams([
      { orgEntityId: 'e1', targetType: 'Principal', targetId: 'u1', confidence: 90, signals: 'email', matchedField: 'email', matchedValue: 'a', via: 'owner', orgValue: 'Ann', status: 'accepted' },
      { orgEntityId: 'e2', targetType: 'Resource', targetId: 'r1', confidence: 30, signals: 'tok', matchedField: 'displayName', matchedValue: null, status: 'proposed' },
    ], RUN);
    expect(p).toHaveLength(12);
    expect(p[0][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(p[0][0]).not.toBe(p[0][1]);
    expect(p.slice(1, 11)).toEqual([
      ['e1', 'e2'], ['Principal', 'Resource'], ['u1', 'r1'], [90, 30], ['email', 'tok'],
      ['email', 'displayName'], ['a', null], ['owner', null], ['Ann', null], ['accepted', 'proposed'],
    ]);
    expect(p[11]).toBe(RUN);
  });
});
