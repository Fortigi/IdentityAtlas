// Context upload — match the member values of a list to accounts, people or resources.
//
//   loadCandidates(db, kind, values) → rows that could match any value (one query)
//   buildMatcher(kind, rows)         → (value) → { id } | { ambiguous: true } | null
//   matchAll(db, valuesByKind)       → { [kind]: Map(value → id) , stats }
//
// Matching order, per kind — the first step that finds anything decides:
//   Principal (accounts): e-mail or UPN (case-insensitive), employeeId, externalId,
//                         exact display name
//   Identity  (people):   e-mail (case-insensitive), employeeId, exact display name
//   Resource:             externalId, exact display name
// A step that finds two different candidates makes the value AMBIGUOUS: it is
// left unmatched rather than guessed (two accounts of one person, two groups
// with one name). Soft-deleted rows never match.

import { isEmailLike } from './profile.js';

const lower = (v) => String(v ?? '').toLowerCase();

// Per kind: the candidate query, and the ordered steps of [row fields, email].
// An `email` step compares case-insensitively and only for a value that is an
// e-mail address — "E1" is an employee number, never a mail address.
const KINDS = {
  Principal: {
    sql: `SELECT id, email, "extendedAttributes"->>'userPrincipalName' AS upn, "employeeId", "externalId", "displayName"
            FROM "Principals"
           WHERE "deletedAt" IS NULL
             AND (lower(email) = ANY($1::text[]) OR lower("extendedAttributes"->>'userPrincipalName') = ANY($1::text[])
                  OR "employeeId" = ANY($2::text[]) OR "externalId" = ANY($2::text[]) OR "displayName" = ANY($2::text[]))`,
    steps: [[['email', 'upn'], true], [['employeeId'], false], [['externalId'], false], [['displayName'], false]],
  },
  Identity: {
    sql: `SELECT id, email, "employeeId", "displayName"
            FROM "Identities"
           WHERE lower(email) = ANY($1::text[]) OR "employeeId" = ANY($2::text[]) OR "displayName" = ANY($2::text[])`,
    steps: [[['email'], true], [['employeeId'], false], [['displayName'], false]],
  },
  Resource: {
    sql: `SELECT id, "externalId", "displayName"
            FROM "Resources"
           WHERE "deletedAt" IS NULL AND ("externalId" = ANY($2::text[]) OR "displayName" = ANY($2::text[]))`,
    steps: [[['externalId'], false], [['displayName'], false]],
  },
};

/** The rows of `kind` that could match one of `values`. */
export async function loadCandidates(db, kind, values) {
  const spec = KINDS[kind];
  if (!spec || values.length === 0) return [];
  const exact = [...new Set(values)];
  const folded = [...new Set(exact.filter(isEmailLike).map(lower))];
  return (await db.query(spec.sql, [folded, exact])).rows;
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

export function buildMatcher(kind, rows) {
  const steps = (KINDS[kind]?.steps ?? []).map(step => indexStep(rows, step));
  return (value) => {
    const isEmail = isEmailLike(String(value));
    for (const { index, email } of steps) {
      if (email && !isEmail) continue;
      const ids = index.get(email ? lower(value) : String(value));
      if (!ids) continue;
      if (ids.size > 1) return { ambiguous: true };
      return { id: [...ids][0] };
    }
    return null;
  };
}

export const MAX_UNMATCHED_SAMPLES = 50;

/**
 * Match every value of every kind.
 * @param {{query: Function}} db
 * @param {Object<string, string[]>} valuesByKind  kind → distinct values
 * @returns {Promise<{ ids: Object<string, Map<string,string>>, stats: object }>}
 *   ids[kind] maps a value to its matched id; stats = { matched, unmatched,
 *   ambiguous, unmatchedSamples: [{ kind, value, reason }] } over all kinds.
 */
// Count one value that matched nothing (or more than one thing) and keep it as a
// sample while there is room.
function countMiss(stats, kind, value, ambiguous) {
  if (ambiguous) stats.ambiguous++; else stats.unmatched++;
  if (stats.unmatchedSamples.length < MAX_UNMATCHED_SAMPLES) {
    stats.unmatchedSamples.push({ kind, value, reason: ambiguous ? 'ambiguous' : 'not found' });
  }
}

export async function matchAll(db, valuesByKind) {
  const ids = {};
  const stats = { matched: 0, unmatched: 0, ambiguous: 0, unmatchedSamples: [] };
  for (const [kind, values] of Object.entries(valuesByKind)) {
    const match = buildMatcher(kind, await loadCandidates(db, kind, values));
    ids[kind] = new Map();
    for (const value of values) {
      const hit = match(value);
      if (hit?.id) { ids[kind].set(value, hit.id); stats.matched++; } else countMiss(stats, kind, value, !!hit?.ambiguous);
    }
  }
  return { ids, stats };
}
