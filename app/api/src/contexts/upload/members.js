// Context upload — match the member (and owner) values of a list to accounts,
// people or resources.
//
//   loadCandidates(db, kind, values) → rows that could match any value (two queries at most)
//   buildMatcher(kind, rows)         → (value) → { id, kind } | { ambiguous: true } | null
//   matchAll(db, valuesByKind)       → { ids: { [kind]: Map(value → id) }, stats }
//
// Matching order, per kind — the first step that finds anything decides:
//   Principal (accounts): e-mail or UPN (case-insensitive), employeeId, externalId,
//                         then the NAME (lib/nameMatch.js)
//   Identity  (people):   e-mail (case-insensitive), employeeId, then the name
//   Resource:             externalId, exact display name
// A key step that finds two different candidates makes the value AMBIGUOUS: it
// is left unmatched rather than guessed (two accounts of one person, two groups
// with one name). Soft-deleted rows never match.
//
// The name step is the one the owner resolution of the ingest uses
// (normalised: accents, case, "Last, First", a " | Org" suffix), with user
// accounts preferred over service principals of the same name — and here, for
// a list of at most a few thousand values, also a near miss (kind 'fuzzy'),
// which the preview lists so the analyst sees it before importing.
//
// Name candidates come from a trigram lookup per distinct value (the
// displayName trigram index of migration 013 for accounts, the search index of
// migration 091 for people), the ten closest each: an index lookup, never a
// scan of every account.

import { isEmailLike } from './profile.js';
import { buildNameMatcher, normalizeName } from '../../lib/nameMatch.js';
import { searchExpression } from '../../lib/entitySearch.js';

const lower = (v) => String(v ?? '').toLowerCase();
export const NAME_CANDIDATES_PER_VALUE = 10;

const PRINCIPAL_COLUMNS = `p.id, p.email, p."extendedAttributes"->>'userPrincipalName' AS upn, p."employeeId", p."externalId",
       p."displayName", p."principalType"`;
const IDENTITY_COLUMNS = 'p.id, p.email, p."employeeId", p."displayName"';

// The ten closest live rows to each name in $1 (normalised names).
function nameSql(table, columns, haystack, live) {
  return `SELECT x.* FROM unnest($1::text[]) v(name)
    CROSS JOIN LATERAL (
      SELECT ${columns} FROM "${table}" p
       WHERE ${live} v.name <% ${haystack}
       ORDER BY word_similarity(v.name, p."displayName") DESC, p.id
       LIMIT ${NAME_CANDIDATES_PER_VALUE}) x`;
}

// Per kind: the key query, the name query (null: no name step), and the ordered
// key steps of [row fields, email]. An `email` step compares case-insensitively
// and only for a value that is an e-mail address — "E1" is an employee number.
const KINDS = {
  Principal: {
    sql: `SELECT ${PRINCIPAL_COLUMNS}
            FROM "Principals" p
           WHERE p."deletedAt" IS NULL
             AND (lower(p.email) = ANY($1::text[]) OR lower(p."extendedAttributes"->>'userPrincipalName') = ANY($1::text[])
                  OR p."employeeId" = ANY($2::text[]) OR p."externalId" = ANY($2::text[]) OR p."displayName" = ANY($2::text[]))`,
    nameSql: nameSql('Principals', PRINCIPAL_COLUMNS, 'p."displayName"', 'p."deletedAt" IS NULL AND'),
    steps: [[['email', 'upn'], true], [['employeeId'], false], [['externalId'], false]],
    preferred: (row) => row.principalType === 'User',
  },
  Identity: {
    sql: `SELECT ${IDENTITY_COLUMNS}
            FROM "Identities" p
           WHERE lower(p.email) = ANY($1::text[]) OR p."employeeId" = ANY($2::text[]) OR p."displayName" = ANY($2::text[])`,
    nameSql: nameSql('Identities', IDENTITY_COLUMNS, searchExpression('identity', 'p'), ''),
    steps: [[['email'], true], [['employeeId'], false]],
    preferred: () => false,
  },
  Resource: {
    sql: `SELECT id, "externalId", "displayName"
            FROM "Resources"
           WHERE "deletedAt" IS NULL AND ("externalId" = ANY($2::text[]) OR "displayName" = ANY($2::text[]))`,
    nameSql: null,
    steps: [[['externalId'], false], [['displayName'], false]],
  },
};

// A name worth a trigram lookup: not an address, and three letters or more.
const nameValues = (values) => [...new Set(values.filter(v => !isEmailLike(v)).map(normalizeName).filter(n => n.length >= 3))];

/** The rows of `kind` that could match one of `values`, each row once. */
export async function loadCandidates(db, kind, values) {
  const spec = KINDS[kind];
  if (!spec || values.length === 0) return [];
  const exact = [...new Set(values)];
  const folded = [...new Set(exact.filter(isEmailLike).map(lower))];
  const rows = (await db.query(spec.sql, [folded, exact])).rows;
  const names = spec.nameSql ? nameValues(exact) : [];
  if (names.length === 0) return rows;
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const r of (await db.query(spec.nameSql, [names])).rows) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

// One index per step: value (folded when the step is case-insensitive) → Set of ids.
function indexStep(rows, [fields, email]) {
  const index = new Map();
  for (const row of rows) {
    for (const f of fields) {
      const raw = row[f];
      if (raw === null || raw === undefined || raw === '') continue;
      const k = email ? lower(raw) : String(raw);
      if (!index.has(k)) index.set(k, new Set());
      index.get(k).add(row.id);
    }
  }
  return { index, email };
}

function keyMatch(steps, value) {
  const isEmail = isEmailLike(String(value));
  for (const { index, email } of steps) {
    if (email && !isEmail) continue;
    const ids = index.get(email ? lower(value) : String(value));
    if (!ids) continue;
    return ids.size > 1 ? { ambiguous: true } : { id: [...ids][0], kind: 'key' };
  }
  return null;
}

/** (value) → { id, kind: 'key'|'name'|'fuzzy', matchedName? } | { ambiguous: true } | null */
export function buildMatcher(kind, rows) {
  const spec = KINDS[kind];
  if (!spec) return () => null;
  const steps = spec.steps.map(step => indexStep(rows, step));
  const byName = spec.nameSql
    ? buildNameMatcher(rows.map(r => ({ id: r.id, name: r.displayName, preferred: spec.preferred(r) })))
    : null;
  return (value) => keyMatch(steps, value) ?? (byName && !isEmailLike(String(value)) ? byName(value) : null);
}

export const MAX_UNMATCHED_SAMPLES = 50;
export const MAX_FUZZY_SAMPLES = 50;

export const emptyStats = () => ({ matched: 0, byName: 0, fuzzy: 0, unmatched: 0, ambiguous: 0, unmatchedSamples: [], fuzzySamples: [] });

// Count one value that matched nothing (or more than one thing) and keep it as a
// sample while there is room.
function countMiss(stats, kind, value, ambiguous) {
  if (ambiguous) stats.ambiguous++; else stats.unmatched++;
  if (stats.unmatchedSamples.length < MAX_UNMATCHED_SAMPLES) {
    stats.unmatchedSamples.push({ kind, value, reason: ambiguous ? 'ambiguous' : 'not found' });
  }
}

function countHit(stats, kind, value, hit) {
  stats.matched++;
  if (hit.kind === 'name') stats.byName++;
  if (hit.kind !== 'fuzzy') return;
  stats.fuzzy++;
  if (stats.fuzzySamples.length < MAX_FUZZY_SAMPLES) stats.fuzzySamples.push({ kind, value, matched: hit.matchedName });
}

/**
 * Match every value of every kind.
 * @param {{query: Function}} db
 * @param {Object<string, string[]>} valuesByKind  kind → distinct values
 * @returns {Promise<{ ids: Object<string, Map<string,string>>, stats: object }>}
 *   ids[kind] maps a value to its matched id; stats = { matched (all of them),
 *   byName, fuzzy (the part of matched found by name / by a near miss),
 *   unmatched, ambiguous, unmatchedSamples: [{ kind, value, reason }],
 *   fuzzySamples: [{ kind, value, matched }] } over all kinds.
 */
export async function matchAll(db, valuesByKind) {
  const ids = {};
  const stats = emptyStats();
  for (const [kind, values] of Object.entries(valuesByKind)) {
    const match = buildMatcher(kind, await loadCandidates(db, kind, values));
    ids[kind] = new Map();
    for (const value of values) {
      const hit = match(value);
      if (hit?.id) { ids[kind].set(value, hit.id); countHit(stats, kind, value, hit); } else countMiss(stats, kind, value, !!hit?.ambiguous);
    }
  }
  return { ids, stats };
}
