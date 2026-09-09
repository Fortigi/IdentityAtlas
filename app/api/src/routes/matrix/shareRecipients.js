// Named recipients of a matrix share (#1166) — normalisation + identity match.
//
// A share is addressed to specific people. The `fgs_…` token says WHICH
// snapshot a URL opens; this module decides WHO may open it. Both halves are
// pure functions over a request payload / a decoded JWT so the rule can be
// tested exhaustively without a database.
//
// The matching key is the lower-cased sign-in name (UPN / e-mail). Which claim
// actually carries it differs per tenant and per token version — `email` is
// only present when the user has a mail attribute, `upn` is v1-shaped,
// `preferred_username` v2-shaped — so a caller is matched against ALL of them,
// plus `oid` against the picked principal's directory id. Anything less
// silently locks out legitimate recipients on some tenants.

import { UUID_RE } from '../../matrix/filterSql.js';

// A single share stays a hand-picked audience; beyond this it is a permission
// or a context, not a share. Extra entries are dropped rather than 400-ing, so
// a paste of a long list still creates a usable share.
export const MAX_RECIPIENTS = 100;

const MAX_NAME_LENGTH = 200;

// Lower-cased, trimmed sign-in name — '' for anything that isn't a string.
// Every comparison in this module goes through it, so the write path and the
// read path can never normalise differently.
export function normalizeUserKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function pickPrincipalId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return UUID_RE.test(id) ? id : null;
}

function pickDisplayName(value) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, MAX_NAME_LENGTH) || null;
}

// The storable recipient rows for a create request. Accepts either a picked
// directory row (`{ principalId, userKey, displayName }`) or a bare sign-in
// name as a string, so an API caller can address a share without first looking
// anyone up. Entries without a usable key are dropped, and duplicates collapse
// on the key — the first occurrence wins, keeping the picked principal id and
// display name that came with it.
export function normalizeRecipients(input) {
  if (!Array.isArray(input)) return [];
  const byKey = new Map();
  for (const raw of input) {
    if (byKey.size >= MAX_RECIPIENTS) break;
    const isString = typeof raw === 'string';
    if (!isString && (!raw || typeof raw !== 'object')) continue;
    const userKey = normalizeUserKey(isString ? raw : raw.userKey);
    if (!userKey || byKey.has(userKey)) continue;
    byKey.set(userKey, {
      userKey,
      principalId: isString ? null : pickPrincipalId(raw.principalId),
      displayName: isString ? null : pickDisplayName(raw.displayName),
    });
  }
  return [...byKey.values()];
}

// Every sign-in name the caller could be listed under, lower-cased. Returns an
// empty array for an unauthenticated request — an empty array matches nothing
// in the `= ANY(...)` lookup, so an open share is impossible to reach by
// accident (the auth-disabled bypass is an explicit branch in the route).
export function identityKeysOf(user) {
  const keys = new Set();
  for (const claim of [user?.email, user?.upn, user?.preferred_username, user?.unique_name]) {
    const key = normalizeUserKey(claim);
    if (key) keys.add(key);
  }
  return [...keys];
}

// The caller's directory object id, when the token carries one — matched
// against the `principalId` the sharer picked. This is what still resolves for
// a recipient whose UPN changed after the share was created.
export function objectIdOf(user) {
  return pickPrincipalId(user?.oid);
}
