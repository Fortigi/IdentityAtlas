// Unit tests for matrix/orgCondition.js — validation and the emitted SQL.
// Pure: no database. Query correctness against real rows is checked by the
// contract tests; here the questions are "which shape is refused", "is every
// user value bound" and "does each entity get the right expansion".

import { describe, it, expect } from 'vitest';
import {
  parseOrgCondition, orgConditionClause,
  MAX_ENTITY_IDS, MAX_ATTRIBUTE_KEY_LENGTH, MAX_ATTRIBUTE_VALUES, MAX_VIAS,
} from './orgCondition.js';
import { createParams } from '../db/sqlParams.js';

const ID_A = 'e0000000-0000-4000-8000-00000000000a';
const ID_B = 'e0000000-0000-4000-8000-00000000000b';
const uuid = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const norm = (s) => s.replace(/\s+/g, ' ');

function build(cond, entity = 'Principal', idExpr = 'id') {
  const { params, bind } = createParams();
  const out = orgConditionClause({ entity, idExpr, cond, bind });
  return { ...out, sql: out.clause ? norm(out.clause) : null, params };
}

describe('parseOrgCondition', () => {
  it('normalises a full condition: dedupes ids, stringifies values, drops empty values, ignores labels', () => {
    const r = parseOrgCondition({
      kind: 'org', entityType: 'Klant', entityIds: [ID_A, ID_B, ID_A],
      attribute: { key: 'iso 27001', values: ['Ja', '', 1, true, null, { x: 1 }, 'Ja'] },
      via: ['eigenaar', 'Uren', 'eigenaar'], labels: { [ID_A]: 'Contoso' },
    });
    expect(r).toEqual({ ok: true, value: {
      entityType: 'Klant', entityIds: [ID_A, ID_B],
      attribute: { key: 'iso 27001', values: ['Ja', '1', 'true'] },
      via: ['eigenaar', 'Uren'],
    } });
  });

  it('treats absent and null optional parts as "no restriction"', () => {
    expect(parseOrgCondition({ entityType: 'Klant' }).value).toEqual({ entityType: 'Klant', entityIds: [], attribute: null, via: [] });
    expect(parseOrgCondition({ entityType: 'Klant', entityIds: null, attribute: null, via: null }).value)
      .toEqual({ entityType: 'Klant', entityIds: [], attribute: null, via: [] });
  });

  it.each([
    ['no object', null, 'not an object'],
    ['no entityType', {}, 'entityType is required'],
    ['blank entityType', { entityType: '   ' }, 'entityType is required'],
    ['numeric entityType', { entityType: 5 }, 'entityType is required'],
    ['too long entityType', { entityType: 'k'.repeat(201) }, 'entityType is required'],
  ])('refuses %s', (_label, cond, error) => {
    expect(parseOrgCondition(cond)).toEqual({ ok: false, error });
  });

  // A bad id list must fail the whole condition: filtering out the bad ids and
  // keeping the rest could leave an EMPTY list, which means "every entity".
  it.each([
    ['a string', ID_A, 'entityIds must be a list'],
    ['a non-uuid among uuids', [ID_A, 'not-a-uuid'], 'entityIds must be UUIDs'],
    ['a number', [ID_A, 7], 'entityIds must be UUIDs'],
    ['one too many', Array.from({ length: MAX_ENTITY_IDS + 1 }, (_, i) => uuid(i)), `more than ${MAX_ENTITY_IDS} entityIds`],
  ])('refuses entityIds that are %s', (_label, entityIds, error) => {
    expect(parseOrgCondition({ entityType: 'Klant', entityIds })).toEqual({ ok: false, error });
  });

  it(`accepts exactly ${MAX_ENTITY_IDS} entityIds`, () => {
    const ids = Array.from({ length: MAX_ENTITY_IDS }, (_, i) => uuid(i));
    expect(parseOrgCondition({ entityType: 'Klant', entityIds: ids }).value.entityIds).toHaveLength(MAX_ENTITY_IDS);
  });

  it.each([
    ['a list', ['iso27001'], 'attribute must be { key, values }'],
    ['a string', 'iso27001', 'attribute must be { key, values }'],
    ['an empty key', { key: '', values: ['Ja'] }, `attribute key must be 1..${MAX_ATTRIBUTE_KEY_LENGTH} characters`],
    ['a too long key', { key: 'k'.repeat(MAX_ATTRIBUTE_KEY_LENGTH + 1), values: ['Ja'] }, `attribute key must be 1..${MAX_ATTRIBUTE_KEY_LENGTH} characters`],
    ['a numeric key', { key: 1, values: ['Ja'] }, `attribute key must be 1..${MAX_ATTRIBUTE_KEY_LENGTH} characters`],
    ['no values list', { key: 'iso27001', values: 'Ja' }, 'attribute values must be a list'],
    ['only empty values', { key: 'iso27001', values: ['', null] }, 'attribute needs at least one value'],
    ['too many values', { key: 'iso27001', values: Array.from({ length: MAX_ATTRIBUTE_VALUES + 1 }, (_, i) => `v${i}`) }, `more than ${MAX_ATTRIBUTE_VALUES} attribute values`],
  ])('refuses an attribute with %s', (_label, attribute, error) => {
    expect(parseOrgCondition({ entityType: 'Klant', attribute })).toEqual({ ok: false, error });
  });

  it('accepts the boundary key length and value count', () => {
    const key = 'k'.repeat(MAX_ATTRIBUTE_KEY_LENGTH);
    const values = Array.from({ length: MAX_ATTRIBUTE_VALUES }, (_, i) => `v${i}`);
    expect(parseOrgCondition({ entityType: 'Klant', attribute: { key, values } }).value.attribute).toEqual({ key, values });
  });

  it.each([
    ['a string', 'eigenaar', 'via must be a list'],
    ['a blank name', ['eigenaar', ' '], 'via names must be non-empty text'],
    ['a number', [3], 'via names must be non-empty text'],
    ['too many names', Array.from({ length: MAX_VIAS + 1 }, (_, i) => `v${i}`), `more than ${MAX_VIAS} via names`],
  ])('refuses a via that is %s', (_label, via, error) => {
    expect(parseOrgCondition({ entityType: 'Klant', via })).toEqual({ ok: false, error });
  });

  it(`accepts exactly ${MAX_VIAS} via names`, () => {
    const via = Array.from({ length: MAX_VIAS }, (_, i) => `v${i}`);
    expect(parseOrgCondition({ entityType: 'Klant', via }).value.via).toEqual(via);
  });
});

describe('orgConditionClause', () => {
  it('binds only the entity type when nothing else is chosen, and keeps accepted/current entities', () => {
    const out = build({ kind: 'org', entityType: 'Klant' });
    expect(out.params).toEqual(['Klant']);
    expect(out.sql).toContain(`WITH org_e AS (SELECT e."id" FROM "OrgEntities" e WHERE e."entityType" = $1 AND e."status" = 'accepted' AND e."validTo" IS NULL)`);
    // No id list, no attribute, no via restriction.
    expect(out.sql).not.toContain('e."id" = ANY');
    expect(out.sql).not.toContain('e."attributes"');
    expect(out.sql).not.toMatch(/"via", 'displayName'\) = ANY/);
    expect(out.sql).not.toContain('f."entityType" = ANY');
  });

  it('prefixes the clause with the caller\'s id expression', () => {
    expect(build({ entityType: 'Klant' }, 'Principal', `(sp.state->>'id')::uuid`).sql)
      .toMatch(/^\(sp\.state->>'id'\)::uuid IN \( WITH org_e AS/);
  });

  it('binds the picked ids as a uuid array', () => {
    const out = build({ entityType: 'Klant', entityIds: [ID_A, ID_B] });
    expect(out.params).toEqual(['Klant', [ID_A, ID_B]]);
    expect(out.sql).toContain('AND e."id" = ANY($2::uuid[])');
  });

  it('binds the attribute KEY as a parameter, never into the SQL text', () => {
    const key = `x'); DROP TABLE "Principals"; --`;
    const out = build({ entityType: 'Klant', attribute: { key, values: ['Ja'] } });
    expect(out.params).toEqual(['Klant', key, ['Ja']]);
    expect(out.sql).toContain(`AND e."attributes"->>($2::text) = ANY($3::text[])`);
    expect(out.sql).not.toContain('DROP TABLE');
  });

  it('combines ids and attribute with AND, numbered in bind order', () => {
    const out = build({ entityType: 'Klant', entityIds: [ID_A], attribute: { key: 'iso27001', values: ['Ja', 'Nee'] } });
    expect(out.params).toEqual(['Klant', [ID_A], 'iso27001', ['Ja', 'Nee']]);
    expect(out.sql).toContain(`e."validTo" IS NULL AND e."id" = ANY($2::uuid[]) AND e."attributes"->>($3::text) = ANY($4::text[])`);
  });

  it('applies one via list to the direct links (via) AND to the through links (fact type)', () => {
    const out = build({ entityType: 'Klant', via: ['eigenaar', 'Uren'] });
    expect(out.params).toEqual(['Klant', ['eigenaar', 'Uren']]);
    expect(out.sql).toContain(`AND l."orgEntityId" IN (SELECT "id" FROM org_e) AND COALESCE(l."via", 'displayName') = ANY($2::text[])`);
    expect(out.sql).toContain(`AND tl."targetId" IN (SELECT "id" FROM org_e) AND f."entityType" = ANY($2::text[])`);
  });

  it('follows through-links only from accepted, current fact rows that link by an attribute', () => {
    const { sql } = build({ entityType: 'Klant' });
    expect(sql).toContain(`JOIN "OrgEntities" f ON f."id" = tl."orgEntityId" AND f."status" = 'accepted' AND f."validTo" IS NULL`);
    expect(sql).toContain(`WHERE tl."status" = 'accepted' AND tl."targetType" = 'OrgEntity' AND COALESCE(tl."via", 'displayName') <> 'displayName'`);
    expect(sql).toContain(`JOIN "OrgLinks" fl ON fl."orgEntityId" = f."id" AND fl."status" = 'accepted' AND fl."targetType" IN ('Principal', 'Identity', 'Resource', 'Context')`);
    expect(sql).toContain(`WHERE l."status" = 'accepted' AND l."targetType" IN ('Principal', 'Identity', 'Resource', 'Context')`);
  });

  it('expands a Principal filter through linked identities (selects principalId, joins on identityId)', () => {
    const { sql } = build({ entityType: 'Klant' }, 'Principal');
    expect(sql).toContain(`SELECT tid FROM org_l WHERE tt = 'Principal'`);
    expect(sql).toContain(`SELECT im."principalId" FROM "IdentityMembers" im JOIN org_l x ON x.tt = 'Identity' AND x.tid = im."identityId"`);
    expect(sql).toContain(`JOIN org_l x ON x.tt = 'Context' AND x.tid = cm."contextId" WHERE cm."memberType" = 'Principal'`);
    expect(sql).not.toContain(`tt = 'Resource'`);
  });

  it('expands an Identity filter through linked accounts (selects identityId, joins on principalId)', () => {
    const { sql } = build({ entityType: 'Klant' }, 'Identity');
    expect(sql).toContain(`SELECT tid FROM org_l WHERE tt = 'Identity'`);
    expect(sql).toContain(`SELECT im."identityId" FROM "IdentityMembers" im JOIN org_l x ON x.tt = 'Principal' AND x.tid = im."principalId"`);
    expect(sql).toContain(`cm."memberType" = 'Identity'`);
    expect(sql).not.toContain(`SELECT tid FROM org_l WHERE tt = 'Principal'`);
  });

  it('gives a Resource filter linked resources and context members only — no identity expansion', () => {
    const { sql } = build({ entityType: 'Klant' }, 'Resource');
    expect(sql).toContain(`SELECT tid FROM org_l WHERE tt = 'Resource' UNION SELECT cm."memberId"`);
    expect(sql).toContain(`cm."memberType" = 'Resource'`);
    expect(sql).not.toContain('IdentityMembers');
  });

  it('drops an invalid condition with a warning and binds nothing', () => {
    const out = build({ entityType: 'Klant', entityIds: ['nope'] });
    expect(out).toEqual({ warning: 'org condition dropped: entityIds must be UUIDs', sql: null, params: [] });
  });

  it('drops the condition for an entity it cannot select, before binding', () => {
    const out = build({ entityType: 'Klant' }, 'System');
    expect(out).toEqual({ warning: 'org condition not supported for System — dropped', sql: null, params: [] });
    // An inherited object key is not a supported entity either.
    expect(build({ entityType: 'Klant' }, 'toString').warning).toBe('org condition not supported for toString — dropped');
  });
});
