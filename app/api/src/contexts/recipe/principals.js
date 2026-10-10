// Context recipe, target 'principal' — who is a member, and why.
//
// Members of a principal recipe =
//     principals holding an assignment of `access.assignmentTypes` on a resource the recipe
//     holds (matched by a kept term, or included by hand — matches.js)
//   ∪ principals linked to an org entity the recipe holds (matched by a kept term, or
//     included by hand; links read through matrix/orgCondition.js)
//   ∪ principalInclude
//   − principalExclude                     (excluding wins over everything)
//
// The SQL is in principalSql.js; everything here is plain JS, testable without a database.

import { termMatches } from './recipe.js';
import { computeMatches } from './matches.js';
import { loadOrgCandidates, loadPrincipalDetails, loadPrincipalSources } from './principalSql.js';

// 'excluded'  removed by the analyst (wins)
// 'matched'   found by a kept term
// 'included'  pinned by the analyst, no kept term finds it
// null        loaded but not part of the recipe — not reported
function orgState(id, termKeys, pinned) {
  if (pinned.exclude.has(id)) return 'excluded';
  if (termKeys.length) return 'matched';
  if (pinned.include.has(id)) return 'included';
  return null;
}

/**
 * Org entity rows (loadOrgCandidates) → the org matches of a recipe.
 * @returns {{ id, entityType, label, termKeys: string[], state: 'matched'|'included'|'excluded' }[]}
 */
export function computeOrgMatches(rows, recipe) {
  const accepted = recipe.terms.filter(t => t.state === 'accepted');
  const pinned = { include: new Set(recipe.orgInclude), exclude: new Set(recipe.orgExclude) };
  const out = [];
  for (const row of rows) {
    const termKeys = row.termScope ? accepted.filter(t => termMatches(row.f0 || ' ', t.key, t.match)).map(t => t.key) : [];
    const state = orgState(row.id, termKeys, pinned);
    if (state) out.push({ id: row.id, entityType: row.entityType, label: row.displayName, termKeys, state });
  }
  return out;
}

const pushTo = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

// principal → how they are reached; resource / entity → the principals it reaches.
function collectVia({ resources, orgMatches, accessRows, orgRows }) {
  const via = new Map();
  const byResource = new Map();
  const byEntity = new Map();
  const resourceLabel = new Map(resources.matches.map(m => [m.id, m.displayName]));
  const held = new Set(resources.memberIds);
  for (const r of accessRows) {
    if (!held.has(r.resourceId)) continue;
    pushTo(via, r.principalId, { kind: 'access', resourceId: r.resourceId, label: resourceLabel.get(r.resourceId) ?? null, assignmentType: r.assignmentType });
    pushTo(byResource, r.resourceId, r.principalId);
  }
  const entityOf = new Map(orgMatches.map(o => [o.id, o]));
  for (const r of orgRows) {
    pushTo(byEntity, r.entityId, r.principalId);
    const entity = entityOf.get(r.entityId);
    if (!entity || entity.state === 'excluded') continue;
    pushTo(via, r.principalId, { kind: 'org', entityId: entity.id, label: entity.label, entityType: entity.entityType });
  }
  return { via, byResource, byEntity };
}

// Per kept term: the members reached through the resources it finds and the org entities it matches.
function membersByTerm(recipe, resources, orgMatches, reach, isMember) {
  const termMembers = new Map();
  recipe.terms.forEach((term, termIndex) => {
    if (term.state !== 'accepted') return;
    const ids = new Set();
    for (const resourceId of resources.termMembers.get(termIndex) ?? []) {
      for (const id of reach.byResource.get(resourceId) ?? []) ids.add(id);
    }
    for (const o of orgMatches) {
      if (o.state !== 'matched' || !o.termKeys.includes(term.key)) continue;
      for (const id of reach.byEntity.get(o.id) ?? []) ids.add(id);
    }
    termMembers.set(termIndex, [...ids].filter(isMember));
  });
  return termMembers;
}

/**
 * @param {object} args
 * @param {object}   args.recipe      a validated principal recipe
 * @param {object}   args.resources   computeMatches() of the recipe's resources
 * @param {object[]} args.orgMatches  computeOrgMatches()
 * @param {object[]} args.accessRows  { resourceId, principalId, assignmentType }
 * @param {object[]} args.orgRows     { entityId, principalId }
 * @param {string[]} args.included    principalInclude ids that exist
 * @returns {{ memberIds: string[], termMembers: Map<number, string[]>, termPrincipals: Record<string, number>,
 *             pinnedIds: string[], via: Map<string, object[]>, linkedPrincipals: Map<string, number> }}
 *   termMembers: per kept term index that reaches anyone, the members it reaches.
 *   termPrincipals: per kept term KEY, how many members it reaches (0 included).
 *   pinnedIds: members no kept term reaches — included users, and users of resources or
 *   entities included by hand.
 */
export function computePrincipals({ recipe, resources, orgMatches, accessRows, orgRows, included }) {
  const reach = collectVia({ resources, orgMatches, accessRows, orgRows });
  const excluded = new Set(recipe.principalExclude);
  const isMember = id => !excluded.has(id);
  const memberIds = [...new Set([...reach.via.keys(), ...included])].filter(isMember);

  const everyTerm = membersByTerm(recipe, resources, orgMatches, reach, isMember);
  const termPrincipals = {};
  for (const [termIndex, ids] of everyTerm) termPrincipals[recipe.terms[termIndex].key] = ids.length;
  const termMembers = new Map([...everyTerm].filter(([, ids]) => ids.length > 0));
  const byTerm = new Set([...termMembers.values()].flat());
  const linkedPrincipals = new Map([...reach.byEntity].map(([id, ids]) => [id, ids.length]));
  return { memberIds, termMembers, termPrincipals, pinnedIds: memberIds.filter(id => !byTerm.has(id)), via: reach.via, linkedPrincipals };
}

/**
 * Run a validated principal recipe against the database.
 * @param {object}   recipe
 * @param {object[]} resourceRows  loadCandidates().rows
 * @param {number}   scopeTotal    loadCandidates().scopeTotal
 */
export async function runPrincipalRecipe(recipe, resourceRows, scopeTotal, tx) {
  const resources = computeMatches(resourceRows, recipe, scopeTotal);
  const org = await loadOrgCandidates(recipe, tx);
  const orgMatches = computeOrgMatches(org.rows, recipe);
  const sources = await loadPrincipalSources(recipe, resources.memberIds, orgMatches, tx);
  const principals = computePrincipals({ recipe, resources, orgMatches, ...sources });
  return { resources, orgMatches, orgTruncated: org.truncated, principals };
}

/**
 * What the evaluate route adds for a principal recipe: the org matches with their
 * linked-user counts, the users (total + a sample by name with how each is reached) and
 * the users each kept term reaches.
 */
export async function evaluatePrincipals(recipe, resourceRows, scopeTotal, tx) {
  const { orgMatches, orgTruncated, principals } = await runPrincipalRecipe(recipe, resourceRows, scopeTotal, tx);
  const details = await loadPrincipalDetails(principals.memberIds, tx);
  return {
    target: 'principal',
    orgMatches: orgMatches.map(o => ({ ...o, linkedPrincipals: principals.linkedPrincipals.get(o.id) ?? 0 })),
    orgTruncated,
    principals: {
      total: principals.memberIds.length,
      sample: details.map(d => ({
        id: d.id, displayName: d.displayName, upn: d.upn ?? null, principalType: d.principalType ?? null,
        via: principals.via.get(d.id) ?? [],
      })),
    },
    termPrincipals: principals.termPrincipals,
  };
}
