// The one search box behind every entity list: users (Principals), identities,
// resources/groups and contexts.
//
// Two modes:
//   - normal:   the entity's identifying columns (name, email, employee id,
//               external id, …), a plain ILIKE over each.
//   - extended: every column below AND every value in extendedAttributes, at
//               any depth — a phone number, a CMDB reference, an HR number.
//               Matched against `ia_search_text(...)`, the expression of the
//               trigram index in migration 091, so it is an index lookup and
//               not a scan of every JSON document.
//
// The extended expression must be IDENTICAL to the index expression or the
// planner silently falls back to a sequential scan. ALL_COLUMNS below is that
// expression's column list; entitySearch.migration.test.js reads the migration
// and fails when the two disagree.

import { likeContains } from '../db/sqlParams.js';

export const SEARCH_ENTITIES = {
  principal: {
    identifying: ['displayName', 'email', 'employeeId', 'externalId'],
    all: ['id', 'displayName', 'email', 'givenName', 'surname', 'employeeId', 'externalId', 'department', 'jobTitle', 'companyName'],
  },
  identity: {
    identifying: ['displayName', 'email', 'jobTitle', 'employeeId'],
    all: ['id', 'displayName', 'email', 'givenName', 'surname', 'employeeId', 'hrAccountId', 'department', 'jobTitle', 'companyName', 'city', 'country', 'officeLocation'],
  },
  resource: {
    identifying: ['displayName', 'description', 'externalId'],
    all: ['id', 'displayName', 'description', 'mail', 'externalId', 'resourceType'],
  },
  context: {
    identifying: ['displayName', 'description', 'externalId'],
    all: ['id', 'displayName', 'description', 'externalId', 'contextType'],
  },
};

// A trigram index only helps from three characters on; a shorter extended
// search would scan every row's JSON, so it falls back to the normal columns.
export const MIN_EXTENDED_LENGTH = 3;

const PHONE_CHARS = /^[0-9 +()./-]+$/;
const MIN_PHONE_DIGITS = 8;
const PHONE_TAIL = 9;

// `?extendedSearch=true` (or 1) on a list request.
export function parseExtendedSearch(query) {
  const v = String(query?.extendedSearch ?? '').toLowerCase();
  return v === 'true' || v === '1';
}

// For a term that looks like a phone number, the digits to look for in the
// digits-only form the index also holds: drop one international (00) or
// national (0) prefix, keep the last nine. "+31 6 1234 5678", "0031612345678"
// and "06-12345678" all become "612345678", which is inside each one's stored
// digits. Null when the term isn't phone-like or the needle adds nothing over
// searching the term as typed.
export function phoneNeedle(term) {
  const t = String(term ?? '').trim();
  if (!PHONE_CHARS.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return null;
  const needle = digits.replace(/^00?/, '').slice(-PHONE_TAIL);
  return needle === t ? null : needle;
}

function quoted(alias, column) {
  return column === 'id' ? `${alias}."id"::text` : `${alias}."${column}"`;
}

// The index expression of migration 091 for this entity, on `alias`.
export function searchExpression(entity, alias) {
  const spec = SEARCH_ENTITIES[entity];
  if (!spec) throw new Error(`unknown search entity: ${entity}`);
  const cols = spec.all.map(c => quoted(alias, c)).join(', ');
  return `public.ia_search_text(ARRAY[${cols}], ${alias}."extendedAttributes")`;
}

// " AND (...)" for the list WHERE, or '' when there is no term. Binds through
// the caller's createParams() binder. `linkedPrincipals` (identities only)
// also matches an identity whose linked accounts match — the phone number is
// on the Entra account, not on the identity.
export function buildSearchWhere(entity, alias, term, { extended = false, linkedPrincipals = false } = {}, bind) {
  const t = String(term ?? '').trim();
  if (!t) return '';
  if (!extended || t.length < MIN_EXTENDED_LENGTH) {
    const s = bind(likeContains(t));
    const ors = SEARCH_ENTITIES[entity].identifying.map(c => `${quoted(alias, c)} ILIKE ${s} ESCAPE '\\'`);
    return ` AND (${ors.join(' OR ')})`;
  }
  const patterns = [bind(likeContains(t))];
  const needle = phoneNeedle(t);
  if (needle) patterns.push(bind(likeContains(needle)));
  const matches = (expr) => patterns.map(p => `${expr} ILIKE ${p} ESCAPE '\\'`);
  const ors = matches(searchExpression(entity, alias));
  if (linkedPrincipals) {
    ors.push(`EXISTS (SELECT 1 FROM "IdentityMembers" _sim JOIN "Principals" _sp ON _sp.id = _sim."principalId"
      WHERE _sim."identityId" = ${alias}.id AND (${matches(searchExpression('principal', '_sp')).join(' OR ')}))`);
  }
  return ` AND (${ors.join(' OR ')})`;
}

// ─── Why did this row match? ──────────────────────────────────────────
// An extended search that returns a person for a phone number has to say so,
// or the result looks random. Computed on the returned page only, from the
// row the endpoint already selected.

function valueMatches(value, lowerTerm, needle) {
  if (value == null || typeof value === 'boolean') return false;
  const s = String(value);
  if (s.toLowerCase().includes(lowerTerm)) return true;
  return Boolean(needle) && PHONE_CHARS.test(s) && s.replace(/\D/g, '').includes(needle);
}

function collectJsonMatches(node, path, lowerTerm, needle, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectJsonMatches(item, path, lowerTerm, needle, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectJsonMatches(v, path ? `${path}.${k}` : k, lowerTerm, needle, out);
  } else if (valueMatches(node, lowerTerm, needle) && !out.includes(path)) {
    out.push(path);
  }
}

// Field names (columns, or dotted extendedAttributes paths) whose value
// matched. `aliases` maps a column to the key the endpoint returned it under
// (the users list returns email as userPrincipalName).
export function matchedFields(entity, row, term, aliases = {}) {
  const t = String(term ?? '').trim();
  if (!t || !row) return [];
  const lowerTerm = t.toLowerCase();
  const needle = phoneNeedle(t);
  const out = [];
  for (const col of SEARCH_ENTITIES[entity].all) {
    if (valueMatches(row[aliases[col] ?? col], lowerTerm, needle)) out.push(col);
  }
  let doc = row.extendedAttributes;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch { doc = null; }
  }
  collectJsonMatches(doc, '', lowerTerm, needle, out);
  // A legacy document stored as one JSON string has no key to name.
  return out.map(f => f || 'extendedAttributes');
}

// Stamp `matchedOn` on each row of an extended search; rows pass through
// untouched otherwise. `fallback` names the match when none of the row's own
// fields did (an identity found through a linked account).
export function withMatchedOn(entity, rows, term, { extended, aliases, fallback } = {}) {
  if (!extended || String(term ?? '').trim().length < MIN_EXTENDED_LENGTH) return rows;
  return rows.map(row => {
    const fields = matchedFields(entity, row, term, aliases);
    return { ...row, matchedOn: fields.length || !fallback ? fields : [fallback] };
  });
}
