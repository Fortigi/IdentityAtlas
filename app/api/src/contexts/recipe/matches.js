// Context recipe — finding the objects a recipe matches.
//
// Two halves, kept apart so the matching rules are testable without a database:
//
//   loadCandidates()  SQL: every object in scope that ANY term (kept or not) finds in
//                     ANY searched field, plus every pinned object — with the searched
//                     fields already normalised the way recipe.normalizeText does.
//   computeMatches()  JS: which terms hit which field of which object, who is a member,
//                     and the per-term numbers the analyst decides with.
//
// Terms the analyst dropped are still evaluated: their hit counts are what shows the
// analyst what ticking the term again would add.

import { searchFieldSql, likePattern, termMatches } from './recipe.js';

export const MAX_CANDIDATES = 5000;
// A term that finds more than this share of everything in scope is too broad to mean
// anything (the idea behind resource-cluster's maxTokenCoverage).
export const TOO_BROAD_SHARE = 0.1;
export const TOO_BROAD_MIN_HITS = 25;
export const STATEMENT_TIMEOUT = '15s';

const ALIAS = 'r';
// Lowercase, every run of non-alphanumerics → one space, padded with a space both ends.
const normalizedSql = (expr) => `(' ' || btrim(regexp_replace(lower(coalesce(${expr}, '')), '[^[:alnum:]]+', ' ', 'g')) || ' ')`;

/**
 * The candidate query for a validated recipe. Every identifier comes from the catalog;
 * resource types, patterns and ids are parameters.
 * @returns {{ text: string, params: any[], countText: string, countParams: any[] }}
 */
export function buildCandidateQuery(recipe, { limit = MAX_CANDIDATES } = {}) {
  const fieldCols = recipe.fields.map((f, i) => `${normalizedSql(searchFieldSql(f, ALIAS))} AS "f${i}"`);
  const patterns = recipe.terms.map(t => likePattern(t.key, t.match));
  // Always present, even with no terms: Postgres refuses a parameter the query never
  // references, and LIKE ANY of an empty array simply matches nothing.
  const anyFieldMatches = recipe.fields
    .map(f => `${normalizedSql(searchFieldSql(f, ALIAS))} LIKE ANY($2::text[])`)
    .join(' OR ');
  const scope = `${ALIAS}."deletedAt" IS NULL AND ${ALIAS}."resourceType" = ANY($1::text[])`;
  const text = `
    SELECT ${ALIAS}."id", ${ALIAS}."displayName", ${ALIAS}."description", ${ALIAS}."resourceType",
           (SELECT s."displayName" FROM "Systems" s WHERE s."id" = ${ALIAS}."systemId") AS "systemName",
           ${fieldCols.join(',\n           ')}
      FROM "Resources" ${ALIAS}
     WHERE ${scope}
       AND (${anyFieldMatches} OR ${ALIAS}."id"::text = ANY($3::text[]))
     ORDER BY ${ALIAS}."displayName"
     LIMIT ${Number(limit) + 1}`;
  return {
    text,
    params: [recipe.resourceTypes, patterns, [...recipe.include, ...recipe.exclude]],
    countText: `SELECT count(*)::int AS n FROM "Resources" ${ALIAS} WHERE ${scope}`,
    countParams: [recipe.resourceTypes],
  };
}

/**
 * Run the candidate query read-only, with a statement timeout.
 * @param {object} recipe  a validated recipe
 * @param {Function} tx    db/connection.js tx
 * @returns {Promise<{ rows: object[], scopeTotal: number, truncated: boolean }>}
 */
export async function loadCandidates(recipe, tx, { limit = MAX_CANDIDATES } = {}) {
  const q = buildCandidateQuery(recipe, { limit });
  return tx(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const { rows } = await client.query(q.text, q.params);
    const { rows: count } = await client.query(q.countText, q.countParams);
    return { rows: rows.slice(0, limit), scopeTotal: count[0]?.n ?? 0, truncated: rows.length > limit };
  });
}

/** For one object: which terms matched, and in which fields. */
function hitsOf(row, recipe) {
  const hits = [];
  recipe.terms.forEach((term, termIndex) => {
    const fields = recipe.fields.filter((_, i) => termMatches(row[`f${i}`] || ' ', term.key, term.match));
    if (fields.length) hits.push({ termIndex, fields });
  });
  return hits;
}

// 'member'    found by a kept term
// 'included'  pinned by the analyst (whether or not a term finds it)
// 'excluded'  removed by the analyst (wins over everything)
// 'candidate' found only by terms the analyst dropped — not a member
function statusOf(row, acceptedHits, pinned) {
  if (pinned.exclude.has(row.id)) return 'excluded';
  if (acceptedHits.length) return 'member';
  if (pinned.include.has(row.id)) return 'included';
  return 'candidate';
}

function emptyTermStats(recipe) {
  return recipe.terms.map(t => ({
    text: t.text, key: t.key, match: t.match, state: t.state, origin: t.origin, why: t.why, own: t.own === true,
    hits: 0, unique: 0, byField: Object.fromEntries(recipe.fields.map(f => [f, 0])), tooBroad: false,
  }));
}

function countTermHits(stats, hits, recipe) {
  const acceptedHits = hits.filter(h => recipe.terms[h.termIndex].state === 'accepted');
  for (const h of hits) {
    const s = stats[h.termIndex];
    s.hits++;
    for (const f of h.fields) s.byField[f]++;
    // Unique = no OTHER kept term finds this object. For a kept term: what would be
    // lost without it. For a dropped term: what ticking it would add.
    if (!acceptedHits.some(a => a.termIndex !== h.termIndex)) s.unique++;
  }
  return acceptedHits;
}

/**
 * @param {object[]} rows       loadCandidates().rows
 * @param {object}   recipe     a validated recipe
 * @param {number}   scopeTotal objects in scope, for the too-broad test
 * @returns {{ terms: object[], matches: object[], memberIds: string[], termMembers: Map<number, string[]>, addedByModel: number }}
 *   addedByModel: members found ONLY by kept terms the model added (not the analyst's own
 *   words, not typed, not related words) — what the builder warns about when it dwarfs the rest.
 */
export function computeMatches(rows, recipe, scopeTotal = 0) {
  const pinned = { include: new Set(recipe.include), exclude: new Set(recipe.exclude) };
  const terms = emptyTermStats(recipe);
  const matches = [];
  const memberIds = [];
  const termMembers = new Map();
  const modelAdded = (termIndex) => recipe.terms[termIndex].origin === 'model' && !recipe.terms[termIndex].own;
  let addedByModel = 0;

  for (const row of rows) {
    const hits = hitsOf(row, recipe);
    const acceptedHits = countTermHits(terms, hits, recipe);
    const status = statusOf(row, acceptedHits, pinned);
    if (status === 'member' || status === 'included') memberIds.push(row.id);
    if (status === 'member') {
      if (acceptedHits.every(h => modelAdded(h.termIndex))) addedByModel++;
      for (const h of acceptedHits) {
        if (!termMembers.has(h.termIndex)) termMembers.set(h.termIndex, []);
        termMembers.get(h.termIndex).push(row.id);
      }
    }
    matches.push({
      id: row.id,
      displayName: row.displayName,
      description: row.description || null,
      resourceType: row.resourceType,
      systemName: row.systemName || null,
      status,
      hits: hits.map(h => ({ term: recipe.terms[h.termIndex].text, fields: h.fields, accepted: recipe.terms[h.termIndex].state === 'accepted' })),
    });
  }

  const broadAt = Math.max(TOO_BROAD_MIN_HITS, Math.ceil(scopeTotal * TOO_BROAD_SHARE));
  for (const t of terms) t.tooBroad = t.hits > broadAt;
  return { terms, matches, memberIds, termMembers, addedByModel };
}
