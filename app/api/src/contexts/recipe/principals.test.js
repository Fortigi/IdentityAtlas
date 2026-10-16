import { describe, it, expect } from 'vitest';
import { validateRecipe } from './recipe.js';
import { computeMatches } from './matches.js';
import { computeOrgMatches, computePrincipals, evaluatePrincipals, runPrincipalRecipe } from './principals.js';
import { buildTree } from '../plugins/context-recipe.js';

const ID = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = (n) => ID('1', n);   // resources
const O = (n) => ID('2', n);   // org entities
const P = (n) => ID('3', n);   // principals

const norm = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
// Resource rows as loadCandidates returns them (f0 = name, f1 = description).
const resource = (n, name) => ({ id: R(n), displayName: name, description: '', resourceType: 'Group', systemName: 'Entra', f0: norm(name), f1: '  ' });
// Org rows as loadOrgCandidates returns them.
const org = (n, name, entityType = 'Klant', termScope = true) => ({ id: O(n), entityType, displayName: name, f0: norm(name), termScope });

const RECIPE = validateRecipe({
  name: 'Users with access to Contoso',
  target: 'principal',
  terms: ['contoso', 'northwind', { text: 'fabrikam', state: 'rejected' }],
  include: [R(3)], exclude: [R(4)],
  orgInclude: [O(3)], orgExclude: [O(2)],
  principalInclude: [P(9)], principalExclude: [P(5)],
}).recipe;

const RESOURCE_ROWS = [resource(1, 'SG_Contoso_Users'), resource(2, 'Northwind App'), resource(3, 'Other'), resource(4, 'Contoso Archive')];
const ORG_ROWS = [
  org(1, 'Contoso Bank'),
  org(2, 'Contoso Old'),                         // excluded by hand
  org(3, 'Tailspin', 'Project'),                 // included by hand, no term finds it
  org(4, 'Contoso staff', 'Staff', false),       // an enrichment list: the terms may not match it
  org(5, 'Fabrikam'),                            // found only by a dropped term
];
const ACCESS_ROWS = [
  { resourceId: R(1), principalId: P(1), assignmentType: 'Direct' },
  { resourceId: R(1), principalId: P(2), assignmentType: 'Indirect' },
  { resourceId: R(2), principalId: P(2), assignmentType: 'Direct' },
  { resourceId: R(3), principalId: P(3), assignmentType: 'Direct' },
  { resourceId: R(4), principalId: P(4), assignmentType: 'Direct' },   // an excluded resource
  { resourceId: R(1), principalId: P(5), assignmentType: 'Direct' },   // an excluded user
];
const ORG_LINK_ROWS = [
  { entityId: O(1), principalId: P(6) },
  { entityId: O(2), principalId: P(7) },
  { entityId: O(3), principalId: P(8) },
  { entityId: O(1), principalId: P(2) },
];

const resources = () => computeMatches(RESOURCE_ROWS, RECIPE, 100);
const orgMatches = () => computeOrgMatches(ORG_ROWS, RECIPE);
const principals = () => computePrincipals({
  recipe: RECIPE, resources: resources(), orgMatches: orgMatches(), accessRows: ACCESS_ROWS, orgRows: ORG_LINK_ROWS, included: [P(9)],
});

describe('computeOrgMatches', () => {
  it('reports matched, included and excluded entities, and leaves out what is not part of the recipe', () => {
    expect(orgMatches()).toEqual([
      { id: O(1), entityType: 'Klant', label: 'Contoso Bank', termKeys: ['contoso'], state: 'matched' },
      { id: O(2), entityType: 'Klant', label: 'Contoso Old', termKeys: ['contoso'], state: 'excluded' },
      { id: O(3), entityType: 'Project', label: 'Tailspin', termKeys: [], state: 'included' },
    ]);
  });

  it('matches an included entity by term as matched, and needs the term to be kept', () => {
    const recipe = validateRecipe({ target: 'principal', terms: [{ text: 'tailspin', state: 'rejected' }, 'bank'], orgInclude: [O(3)] }).recipe;
    expect(computeOrgMatches(ORG_ROWS, recipe).map(o => [o.label, o.state, o.termKeys])).toEqual([
      ['Contoso Bank', 'matched', ['bank']],
      ['Tailspin', 'included', []],
    ]);
  });
});

describe('computePrincipals', () => {
  it('members = access ∪ org links ∪ included users − excluded users', () => {
    // Not P4 (excluded resource), not P5 (excluded user), not P7 (excluded entity).
    expect(principals().memberIds).toEqual([P(1), P(2), P(3), P(6), P(8), P(9)]);
  });

  it('records every way a user is reached', () => {
    expect(principals().via.get(P(2))).toEqual([
      { kind: 'access', resourceId: R(1), label: 'SG_Contoso_Users', assignmentType: 'Indirect' },
      { kind: 'access', resourceId: R(2), label: 'Northwind App', assignmentType: 'Direct' },
      { kind: 'org', entityId: O(1), label: 'Contoso Bank', entityType: 'Klant' },
    ]);
    expect(principals().via.has(P(7))).toBe(false);
  });

  it('counts the users each kept term reaches through resources AND org entities, without excluded users', () => {
    // contoso: P1, P2 (and excluded P5) via SG_Contoso_Users; P6, P2 via Contoso Bank. northwind: P2.
    expect(principals().termPrincipals).toEqual({ contoso: 3, northwind: 1 });
    expect([...principals().termMembers]).toEqual([[0, [P(1), P(2), P(6)]], [1, [P(2)]]]);
  });

  it('puts users no kept term reaches under "added by hand": included users, and users of hand-picked resources and entities', () => {
    expect(principals().pinnedIds).toEqual([P(3), P(8), P(9)]);
  });

  it('counts linked users per org entity, the excluded one too (what excluding it removes)', () => {
    expect([...principals().linkedPrincipals]).toEqual([[O(1), 2], [O(2), 1], [O(3), 1]]);
  });

  it('reports a kept term that reaches nobody as 0, without a tree child', () => {
    const recipe = validateRecipe({ target: 'principal', terms: ['contoso', 'nowhere'] }).recipe;
    const r = computePrincipals({ recipe, resources: computeMatches(RESOURCE_ROWS, recipe, 100), orgMatches: [], accessRows: ACCESS_ROWS, orgRows: [], included: [] });
    expect(r.termPrincipals).toEqual({ contoso: 4, nowhere: 0 });
    expect([...r.termMembers.keys()]).toEqual([0]);
  });
});

describe('buildTree for a principal recipe', () => {
  it('a root, a child per term with the users it reaches, and an "Added by hand" child — all in users', () => {
    const { contexts, members } = buildTree(RECIPE, principals());
    expect(contexts.map(c => [c.externalId, c.displayName, c.description])).toEqual([
      ['root', 'Users with access to Contoso', '6 users found by: contoso, northwind.'],
      ['term:contoso', 'contoso', '3 users found by "contoso".'],
      ['term:northwind', 'northwind', '1 users found by "northwind".'],
      ['pinned', 'Added by hand', '3 users included by hand.'],
    ]);
    expect(contexts[0].extendedAttributes).toMatchObject({ target: 'principal', assignmentTypes: ['Direct', 'Indirect'] });
    expect(members.filter(m => m.contextExternalId === 'pinned').map(m => m.memberId)).toEqual([P(3), P(8), P(9)]);
  });
});

// A transaction whose client answers each statement of principalSql.js from fixtures.
function fakeTx(seen = []) {
  const answer = (sql) => {
    // The link statement reads OrgEntities too (inside orgConditionClause), so it is tested first.
    if (sql.includes('AS "entityId"')) return ORG_LINK_ROWS;
    if (sql.includes('FROM "OrgEntities" e')) return ORG_ROWS;
    if (sql.includes('FROM "ResourceAssignments"')) return ACCESS_ROWS;
    if (sql.includes('ORDER BY lower(p."displayName")')) {
      return [{ id: P(9), displayName: 'Ann Example', upn: 'ann@contoso.com', principalType: 'User' }, { id: P(2), displayName: 'Bob', upn: null, principalType: 'ServicePrincipal' }];
    }
    if (sql.includes('SELECT p."id" FROM "Principals"')) return [{ id: P(9) }];
    return [];
  };
  return async (fn) => fn({ query: async (sql, params) => { seen.push({ sql, params }); return { rows: answer(sql) }; } });
}

describe('runPrincipalRecipe / evaluatePrincipals', () => {
  it('asks access only for the resources the recipe holds, with its assignment types', async () => {
    const seen = [];
    const { principals: p } = await runPrincipalRecipe(RECIPE, RESOURCE_ROWS, 100, fakeTx(seen));
    const access = seen.find(s => s.sql.includes('FROM "ResourceAssignments"'));
    expect(access.params).toEqual([[R(1), R(2), R(3)], ['Direct', 'Indirect']]);
    expect(p.memberIds).toEqual([P(1), P(2), P(3), P(6), P(8), P(9)]);
  });

  it('answers the evaluate additions: org matches with link counts, users with via, per-term counts', async () => {
    const seen = [];
    const out = await evaluatePrincipals(RECIPE, RESOURCE_ROWS, 100, fakeTx(seen));
    expect(out.target).toBe('principal');
    expect(out.orgMatches.map(o => [o.label, o.state, o.linkedPrincipals])).toEqual([
      ['Contoso Bank', 'matched', 2], ['Contoso Old', 'excluded', 1], ['Tailspin', 'included', 1],
    ]);
    expect(out.principals.total).toBe(6);
    expect(out.principals.sample).toEqual([
      { id: P(9), displayName: 'Ann Example', upn: 'ann@contoso.com', principalType: 'User', via: [] },
      { id: P(2), displayName: 'Bob', upn: null, principalType: 'ServicePrincipal', via: principalsVia(P(2)) },
    ]);
    expect(out.termPrincipals).toEqual({ contoso: 3, northwind: 1 });
    expect(out.orgTruncated).toBe(false);
    // The sample is read for the members only.
    expect(seen.find(s => s.sql.includes('ORDER BY lower')).params).toEqual([[P(1), P(2), P(3), P(6), P(8), P(9)]]);
  });
});

function principalsVia(id) {
  return principals().via.get(id);
}
