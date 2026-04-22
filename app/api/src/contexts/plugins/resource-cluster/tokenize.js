// Tokenizer + stopword filter for the resource-cluster plugin.
//
// The token-based clustering algorithm splits a resource name on common
// separators, lowercases each fragment, drops anything that's too short,
// purely numeric, or a known "noise" word (role suffixes, environment
// tags, AD group-type prefixes, management-unit prefixes). What remains
// is the set of "interesting" tokens a cluster might form around.
//
// Example:
//   "SG_APP_HAMIS_Admins_P"        → ["hamis"]
//   "GRP-HAMIS-ReadOnly-TST"       → ["hamis"]
//   "HAMIS Editors"                → ["hamis", "editors"]  (editors not in
//                                    default stopwords, but add it via
//                                    additionalStopwords if it's noise)
//
// Two tokens cluster the same resources iff the token appears in both
// names. The plugin uses this to build a cluster per token that appears
// in ≥ minMembers resources.

// Role / authority suffixes, lowercased. Covers EN + NL variants.
const ROLE_WORDS = [
  'admin', 'admins', 'administrator', 'administrators',
  'user', 'users', 'member', 'members', 'owner', 'owners',
  'readonly', 'readwrite', 'fullaccess', 'full', 'access',
  'viewer', 'viewers', 'reader', 'readers', 'writer', 'writers',
  'contributor', 'contributors', 'editor', 'editors',
  'guest', 'guests',
  'beheer', 'beheerder', 'beheerders', 'gebruiker', 'gebruikers',
  'leden', 'lid', 'eigenaar', 'eigenaars',
];

// Environment / lifecycle tokens.
const ENV_WORDS = [
  'p', 'a', 't', 'd',
  'acc', 'tst', 'dev', 'prod', 'production', 'test', 'testing',
  'ont', 'ontw', 'ontwikkeling', 'stg', 'staging', 'sbx', 'sandbox',
  'uat', 'qa', 'preprod', 'pre', 'post',
];

// Common AD / directory group-type prefixes.
const TYPE_WORDS = [
  'sg', 'dl', 'ag', 'sec', 'secgrp', 'secgroup',
  'm365', 'aad', 'grp', 'group', 'groups',
  'team', 'teams', 'cg', 'ps', 'ts',
  'app', 'apps', 'application', 'applications',
];

// Generic filler words.
const FILLER_WORDS = [
  'all', 'none', 'general', 'misc', 'other', 'common',
  'role', 'roles', 'perm', 'perms', 'permission', 'permissions',
];

export const DEFAULT_STOPWORDS = new Set([
  ...ROLE_WORDS,
  ...ENV_WORDS,
  ...TYPE_WORDS,
  ...FILLER_WORDS,
]);

// Splits on runs of [-_./|\s]; keeps alphanumeric tokens.
const SEPARATOR_RE = /[-_./|\s\\]+/;
const NUMERIC_RE = /^\d+$/;

export function tokenize(name, {
  minTokenLength = 3,
  stopwords = DEFAULT_STOPWORDS,
} = {}) {
  if (!name) return [];
  const parts = String(name).toLowerCase().split(SEPARATOR_RE).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    if (part.length < minTokenLength) continue;
    if (NUMERIC_RE.test(part)) continue;
    if (stopwords.has(part)) continue;
    // Preserve order, dedupe within one name.
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

// Convenience: derive an effective stopword set from defaults + user-supplied
// additions. Accepts an array of strings (case-insensitive) and returns a Set.
export function buildStopwords(additional = []) {
  const combined = new Set(DEFAULT_STOPWORDS);
  for (const w of additional || []) {
    combined.add(String(w).toLowerCase());
  }
  return combined;
}

// Pretty-print a token for display: dashes → spaces, title case.
// Preserves all-caps inputs (HAMIS stays HAMIS) because those are almost
// always acronyms that the analyst recognises at a glance.
export function prettifyToken(token) {
  if (!token) return '';
  // If the token in the source data is all-caps for this exact sequence,
  // caller should pass that in; tokenize lowercases everything, so we
  // can't recover casing. Upper-case 3-4 char acronyms by default.
  if (token.length <= 5) return token.toUpperCase();
  return token
    .split('-')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}
