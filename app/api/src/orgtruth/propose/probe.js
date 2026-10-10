// Organisation truth — probe the VALUES of a list's columns against what is
// already known, so the proposal can say "this column holds people" or "this
// column names customers from the customer list" even when the header is just
// "Column 3".
//
//   probeColumns(columns, rows, targets) → { [columnName]: { values, people, resources, orgEntities, orgEntityTypes } }
//   loadProbeTargets()                   → targets (one read of Principals, Resources, OrgEntities)
//   findCompositeKey(columns, rows)      → string[] | null
//
// Per column, up to MAX_PROBE distinct non-empty values (split like the link
// engine splits a cell: SharePoint lookups, address lists) are tested:
//   people       share matching a human account's display name exactly, by full name, or its e-mail address
//   resources    share matching a resource's display name exactly
//   orgEntities  share matching an entity of another list (fuzzy ≥ ORG_SIMILARITY)
//   orgEntityTypes the entity types those matches belong to, most frequent first
// Shares are 0..1 of the probed values. Pure given `targets`; the loader is the
// only part that reads the database.
import { query } from '../../db/connection.js';
import { NON_HUMAN_PRINCIPAL_TYPES } from '../../accountlinking/orphanQuery.js';
import { OWNERSHIP_TYPES_SQL } from '../../lib/ownershipTypes.js';
import { parseName } from '../../accountlinking/classifier.js';
import { normValue, fuzzySimilarity, fuzzyWords } from '../linking/signals.js';
import { splitValues } from '../import/applyRecipe.js';

export const MAX_PROBE = 200;
export const ORG_SIMILARITY = 0.8;

export async function loadProbeTargets() {
  const [people, resources, org, identities] = await Promise.all([
    query(`SELECT "displayName", "givenName", "surname", "email" FROM "Principals"
            WHERE "deletedAt" IS NULL AND ("principalType" IS NULL OR "principalType" <> ALL($1::text[]))`, [NON_HUMAN_PRINCIPAL_TYPES]),
    query(`SELECT "displayName" FROM "Resources" WHERE "deletedAt" IS NULL
            AND ("resourceType" IS NULL OR "resourceType" NOT IN ${OWNERSHIP_TYPES_SQL})`),
    query(`SELECT "displayName", "entityType" FROM "OrgEntities" WHERE "status" = 'accepted' AND "validTo" IS NULL`),
    query(`SELECT EXISTS (SELECT 1 FROM "Identities") AS "any"`),
  ]);
  return buildTargets(people.rows, resources.rows, org.rows, identities.rows[0]?.any === true);
}

/**
 * Index the target rows for probing (pure). `hasIdentities`: account correlation
 * has produced identities, so a list of people can enrich those (templateRecipes.js).
 */
export function buildTargets(people, resources, orgEntities, hasIdentities = false) {
  const resourceNames = new Set(resources.map(r => normValue(r.displayName)).filter(Boolean));
  return { ...indexPeople(people), resourceNames, orgByWord: indexOrgEntities(orgEntities), hasIdentities };
}

// exact display names, full-name keys (both name parts present), and e-mail addresses
function indexPeople(people) {
  const personNames = new Set();
  const personKeys = new Set();
  const personEmails = new Set();
  for (const p of people) {
    if (p.displayName) personNames.add(normValue(p.displayName));
    if (p.email) personEmails.add(normValue(p.email));
    const k = parseName(p.displayName ?? '', p.givenName, p.surname).key;
    if (k && !k.startsWith('|') && !k.endsWith('|')) personKeys.add(k);
  }
  return { personNames, personKeys, personEmails };
}

// org entities indexed by word for the fuzzy comparison
function indexOrgEntities(orgEntities) {
  const orgByWord = new Map();
  for (const e of orgEntities) {
    for (const w of fuzzyWords(e.displayName ?? '').filter(x => x.length >= 2)) {
      const list = orgByWord.get(w);
      if (list) list.push(e); else orgByWord.set(w, [e]);
    }
  }
  return orgByWord;
}

function isPerson(v, t) {
  if (t.personNames.has(normValue(v)) || t.personEmails.has(normValue(v))) return true;
  const k = parseName(v).key;
  return !!k && t.personKeys.has(k);
}

function orgMatch(v, t) {
  const seen = new Set();
  let best = null;
  for (const w of fuzzyWords(v)) {
    for (const e of t.orgByWord.get(w) ?? []) {
      if (seen.has(e)) continue;
      seen.add(e);
      const sim = fuzzySimilarity(v, e.displayName);
      if (sim >= ORG_SIMILARITY && (!best || sim > best.sim)) best = { sim, entityType: e.entityType };
    }
  }
  return best;
}

function distinctValues(rows, column) {
  const out = new Set();
  for (const row of rows) {
    const raw = String(row?.[column] ?? '').trim();
    if (!raw) continue;
    for (const v of splitValues(raw)) {
      out.add(v.trim());
      if (out.size >= MAX_PROBE) return [...out];
    }
  }
  return [...out];
}

function probeOne(values, t) {
  let people = 0; let resources = 0; let org = 0;
  const types = new Map();
  for (const v of values) {
    if (isPerson(v, t)) people += 1;
    if (t.resourceNames.has(normValue(v))) resources += 1;
    const m = orgMatch(v, t);
    if (m) { org += 1; types.set(m.entityType, (types.get(m.entityType) ?? 0) + 1); }
  }
  const share = (n) => (values.length === 0 ? 0 : Math.round((n / values.length) * 100) / 100);
  return {
    values: values.length, people: share(people), resources: share(resources), orgEntities: share(org),
    orgEntityTypes: [...types.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type),
  };
}

export function probeColumns(columns, rows, targets) {
  const out = {};
  for (const c of columns) {
    const name = typeof c === 'string' ? c : c.name;
    out[name] = probeOne(distinctValues(rows, name), targets);
  }
  return out;
}

// The smallest set of columns (2..4, in file order, measures left out) whose
// combined values are unique on every non-empty row: the key of a fact list
// such as a timesheet (year + month + person + customer). Null when none is.
export function findCompositeKey(columns, rows, { maxSize = 4 } = {}) {
  const usable = columns.filter(c => c.nonEmpty > 0 && !isMeasure(c)).map(c => c.name);
  for (let size = 2; size <= Math.min(maxSize, usable.length); size++) {
    for (const combo of combinations(usable, size)) {
      if (isUniqueOn(rows, combo)) return combo;
    }
  }
  return null;
}

// A number with decimals (hours, amounts) measures something; it is no part of a key.
function isMeasure(c) {
  return c.shape === 'number' && (c.samples ?? []).some(s => /[.,]\d/.test(s));
}

function isUniqueOn(rows, cols) {
  const seen = new Set();
  for (const row of rows) {
    const parts = cols.map(c => String(row?.[c] ?? '').trim());
    if (parts.every(p => p === '')) continue;
    const key = parts.join('\u0000').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return seen.size > 0;
}

function* combinations(items, size, start = 0, acc = []) {
  if (acc.length === size) { yield acc; return; }
  for (let i = start; i < items.length; i++) yield* combinations(items, size, i + 1, [...acc, items[i]]);
}
