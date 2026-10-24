// "Who is the signed-in user, in our own data?"
//
// Maps the caller's token claims onto the crawled Principal (their account)
// and, through IdentityMembers, onto the Identity (the person — which may own
// several accounts across systems).
//
// This is deliberately a shared resolver rather than a lookup buried in one
// endpoint. Anything that has to answer a first-person question needs exactly
// this mapping:
//
//   - the header avatar ("my photo")
//   - "show me my groups"      → the Identity's assignments, across accounts
//   - "show me my employees"   → the Identity as a manager
//
// Resolution order, most to least exact:
//
//   1. `oid` — for an Entra-issued token this IS the Graph user object id,
//      which the Entra crawler stores verbatim as Principals.id. An exact
//      key, no string matching, no ambiguity. This is the path that hits in
//      the normal deployment (the tenant signs in to its own crawled data).
//   2. `preferred_username` / `upn` / `email` — a case-insensitive match on
//      Principals.email. The fallback for when the signed-in tenant is not
//      the crawled one, or the account came from a non-Entra source. Only
//      accepted when it matches exactly ONE enabled principal: two accounts
//      sharing a mail address must not silently resolve to the wrong person.
//
// Returns null when auth is off, when the token carries no usable claim, or
// when nothing matches — every caller treats "no mapping" as a normal state,
// not an error. A fresh deployment has no crawled data at all.

import * as db from '../db/connection.js';
import { isMissingSchema } from '../db/schemaErrors.js';

// Pull the candidate claims off a decoded JWT. Entra puts the UPN in
// `preferred_username` for v2 tokens and `upn` for v1; `email` is present on
// some guest/B2B tokens only.
export function claimsFrom(user) {
  if (!user) return { oid: null, upn: null };
  const oid = typeof user.oid === 'string' && user.oid.trim() ? user.oid.trim() : null;
  const upn = [user.preferred_username, user.upn, user.email]
    .find((v) => typeof v === 'string' && v.includes('@'));
  return { oid, upn: upn ? upn.trim() : null };
}

const PRINCIPAL_COLS = `id, "displayName", email, "principalType", "jobTitle", "department",
       "systemId", ("photo" IS NOT NULL) AS "hasPhoto"`;

// Look the principal up by object id, then by mail. Exported for tests.
export async function findPrincipal(pool, { oid, upn }) {
  if (oid) {
    const byId = await pool.query(
      `SELECT ${PRINCIPAL_COLS} FROM "Principals" WHERE id = $1 AND "deletedAt" IS NULL`,
      [oid],
    );
    if (byId.rows.length === 1) return { principal: byId.rows[0], matchedOn: 'oid' };
  }

  if (upn) {
    // LIMIT 2, not 1 — we need to SEE a second match to reject it. Selecting
    // one row would silently pick an arbitrary account of the two.
    const byMail = await pool.query(
      `SELECT ${PRINCIPAL_COLS} FROM "Principals"
        WHERE lower(email) = lower($1) AND "deletedAt" IS NULL
        LIMIT 2`,
      [upn],
    );
    if (byMail.rows.length === 1) return { principal: byMail.rows[0], matchedOn: 'email' };
  }

  return null;
}

// The Identity this principal belongs to, if account correlation has linked
// it. Null is ordinary: correlation may not have run, or this account may be
// unlinked.
export async function findIdentity(pool, principalId) {
  const r = await pool.query(
    `SELECT i.id, i."displayName", i."accountCount", i."primaryPrincipalId"
       FROM "IdentityMembers" m
       JOIN "Identities" i ON i.id = m."identityId"
      WHERE m."principalId" = $1
      LIMIT 1`,
    [principalId],
  );
  return r.rows[0] || null;
}

// The photo bytes for one principal, as a data URI ready for an <img src>,
// or null when there is none.
//
// Kept out of resolveMe() on purpose: the resolver reports `hasPhoto` and
// nothing more, so a caller that only needs the mapping (an "ask" request
// answering "my groups") never reads the blob. Callers that want to SHOW a
// face — the header avatar, the user detail page — make this second, cheap
// call once.
export async function getPrincipalPhoto(pool, principalId) {
  const r = await pool.query(
    `SELECT "photo", "photoContentType" FROM "Principals" WHERE id = $1`,
    [principalId],
  );
  return toPhotoDataUri(r.rows[0]);
}

// Shape a { photo, photoContentType } row into a data URI. Exported because
// callers that already hold the row (the detail endpoint does a SELECT *)
// shouldn't re-query for bytes they have.
export function toPhotoDataUri(row) {
  const bytes = row?.photo;
  if (!bytes || !bytes.length) return null;
  const type = row.photoContentType || 'image/jpeg';
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

// Resolve req.user → { principal, identity, matchedOn } or null.
export async function resolveMe(user) {
  const claims = claimsFrom(user);
  if (!claims.oid && !claims.upn) return null;

  try {
    const pool = await db.getPool();
    const hit = await findPrincipal(pool, claims);
    if (!hit) return null;
    const identity = await findIdentity(pool, hit.principal.id);
    return { principal: hit.principal, identity, matchedOn: hit.matchedOn };
  } catch (err) {
    // A deployment mid-migration has no Principals table yet. That is not an
    // error for the caller — it just means "no mapping available".
    if (isMissingSchema(err)) return null;
    console.error('resolveMe failed:', err.message);
    return null;
  }
}
