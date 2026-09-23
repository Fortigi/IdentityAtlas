// Unit tests for the signed-in-user → crawled-data mapping.
//
// Inputs are chosen to DISCRIMINATE rather than merely execute: each case is
// one that a plausible wrong implementation would get wrong. Where a test
// asserts a fallback, it also asserts that the preferred path was not taken
// (query counts), because "returned the right answer" and "returned it for the
// right reason" are different claims and only the second survives a refactor.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared manual mock (src/db/__mocks__/connection.js) rather than an
// inline factory: its getPool() forwards to the exported `query` spy, so
// results stage the same way whether a caller holds a pool or goes through
// db.getPool().
vi.mock('../db/connection.js');

import { query } from '../db/connection.js';
import {
  claimsFrom, findPrincipal, findIdentity, resolveMe,
  toPhotoDataUri, getPrincipalPhoto,
} from './resolveMe.js';

const PRINCIPAL = {
  id: '11111111-1111-1111-1111-111111111111',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  principalType: 'User',
  hasPhoto: false,
};

// A pool whose query() returns each queued result in turn.
function poolReturning(...resultSets) {
  const query = vi.fn();
  for (const rows of resultSets) query.mockResolvedValueOnce({ rows });
  // Anything beyond the queued sets returns empty rather than undefined, so an
  // implementation that queries MORE than expected fails on the assertion
  // rather than on a TypeError that could mask which call was extra.
  query.mockResolvedValue({ rows: [] });
  return { query };
}

// Stage results on the shared `query` spy for the resolveMe() cases. Only
// clear call history — resetting would drop getPool's forwarding to `query`.
function stageQuery(...resultSets) {
  for (const rows of resultSets) query.mockResolvedValueOnce({ rows });
  query.mockResolvedValue({ rows: [] });
}

beforeEach(() => { vi.clearAllMocks(); });

// ── claimsFrom ───────────────────────────────────────────────────────────────

describe('claimsFrom', () => {
  it('returns empty claims for a missing user', () => {
    expect(claimsFrom(null)).toEqual({ oid: null, upn: null });
    expect(claimsFrom(undefined)).toEqual({ oid: null, upn: null });
  });

  it('trims an oid and rejects one that is only whitespace', () => {
    // Two halves of the same rule. Without the trim, the first returns a
    // padded id that would never match a database key; without the
    // whitespace check, the second returns '   ' and sends a guaranteed-miss
    // query. Asserting both means a trim cannot be dropped silently.
    expect(claimsFrom({ oid: '  abc  ' }).oid).toBe('abc');
    expect(claimsFrom({ oid: '   ' }).oid).toBeNull();
  });

  it('prefers preferred_username over upn and email', () => {
    const claims = claimsFrom({
      preferred_username: 'first@example.com',
      upn: 'second@example.com',
      email: 'third@example.com',
    });
    expect(claims.upn).toBe('first@example.com');
  });

  it('falls through to the next claim when an earlier one is not an address', () => {
    // Entra v1 tokens can carry a non-address preferred_username (a sAMAccount
    // style name). Picking it anyway would mean matching Principals.email
    // against something that is not an email — a silent miss, or worse a
    // false hit. The '@' test is what prevents that, so it gets its own case.
    const claims = claimsFrom({ preferred_username: 'ADA', upn: 'ada@example.com' });
    expect(claims.upn).toBe('ada@example.com');
  });

  it('returns a null upn when no claim looks like an address', () => {
    expect(claimsFrom({ preferred_username: 'ADA', upn: 'DOMAIN\\ada' }).upn).toBeNull();
  });
});

// ── findPrincipal ────────────────────────────────────────────────────────────

describe('findPrincipal', () => {
  it('matches on oid and does not fall back to email', async () => {
    const pool = poolReturning([PRINCIPAL]);
    const hit = await findPrincipal(pool, { oid: PRINCIPAL.id, upn: 'ada@example.com' });

    expect(hit).toEqual({ principal: PRINCIPAL, matchedOn: 'oid' });
    // The count is the real assertion: an implementation that ran both
    // lookups and preferred one would still return the right principal here.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('falls back to email when the oid matches nothing', async () => {
    const pool = poolReturning([], [PRINCIPAL]);
    const hit = await findPrincipal(pool, { oid: 'no-such-id', upn: 'ada@example.com' });

    expect(hit).toEqual({ principal: PRINCIPAL, matchedOn: 'email' });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('refuses an email shared by two principals', async () => {
    // The reason the query asks for two rows. A shared mail address (a
    // migrated mailbox, a shared account) must resolve to nobody rather than
    // to whichever row the database happened to return first — silently
    // showing one person another person's data is the failure being prevented.
    const other = { ...PRINCIPAL, id: '22222222-2222-2222-2222-222222222222' };
    const pool = poolReturning([PRINCIPAL, other]);

    expect(await findPrincipal(pool, { oid: null, upn: 'ada@example.com' })).toBeNull();
  });

  it('queries nothing when the token carries neither claim', async () => {
    const pool = poolReturning();
    expect(await findPrincipal(pool, { oid: null, upn: null })).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('passes the email through case-insensitively as given', async () => {
    const pool = poolReturning([], [PRINCIPAL]);
    await findPrincipal(pool, { oid: 'x', upn: 'Ada@Example.COM' });
    expect(pool.query.mock.calls[1][1]).toEqual(['Ada@Example.COM']);
  });
});

// ── findIdentity ─────────────────────────────────────────────────────────────

describe('findIdentity', () => {
  it('returns the linked identity', async () => {
    const identity = { id: 'id-1', displayName: 'Ada Lovelace', accountCount: 2 };
    const pool = poolReturning([identity]);
    expect(await findIdentity(pool, PRINCIPAL.id)).toEqual(identity);
  });

  it('returns null when the account is not linked to an identity', async () => {
    const pool = poolReturning([]);
    expect(await findIdentity(pool, PRINCIPAL.id)).toBeNull();
  });
});

// ── toPhotoDataUri ───────────────────────────────────────────────────────────

describe('toPhotoDataUri', () => {
  it('encodes bytes with the stored content type', () => {
    const row = { photo: Buffer.from([1, 2, 3]), photoContentType: 'image/png' };
    expect(toPhotoDataUri(row)).toBe('data:image/png;base64,AQID');
  });

  it('defaults to jpeg when the source recorded no content type', () => {
    const row = { photo: Buffer.from([1, 2, 3]), photoContentType: null };
    expect(toPhotoDataUri(row)).toBe('data:image/jpeg;base64,AQID');
  });

  it('returns null for a missing row, a null photo, and a zero-length photo', () => {
    // The zero-length case is the one worth stating: a stored-but-empty blob
    // would otherwise produce `data:image/jpeg;base64,` — a valid-looking src
    // that renders as a broken image instead of falling back to the initial.
    expect(toPhotoDataUri(undefined)).toBeNull();
    expect(toPhotoDataUri({ photo: null })).toBeNull();
    expect(toPhotoDataUri({ photo: Buffer.alloc(0) })).toBeNull();
  });
});

describe('getPrincipalPhoto', () => {
  it('reads the row and shapes it', async () => {
    const pool = poolReturning([{ photo: Buffer.from([255]), photoContentType: 'image/jpeg' }]);
    expect(await getPrincipalPhoto(pool, PRINCIPAL.id)).toBe('data:image/jpeg;base64,/w==');
  });

  it('returns null when the principal has no row', async () => {
    expect(await getPrincipalPhoto(poolReturning([]), PRINCIPAL.id)).toBeNull();
  });
});

// ── resolveMe ────────────────────────────────────────────────────────────────

describe('resolveMe', () => {
  it('resolves principal and identity together', async () => {
    const identity = { id: 'id-1', displayName: 'Ada Lovelace', accountCount: 2 };
    stageQuery([PRINCIPAL], [identity]);

    expect(await resolveMe({ oid: PRINCIPAL.id })).toEqual({
      principal: PRINCIPAL, identity, matchedOn: 'oid',
    });
  });

  it('resolves the principal even when no identity is linked', async () => {
    // Account correlation may not have run. A person with an account but no
    // identity must still get a mapping — returning null here would hide the
    // header avatar on every fresh deployment.
    stageQuery([PRINCIPAL], []);

    const me = await resolveMe({ oid: PRINCIPAL.id });
    expect(me.principal).toEqual(PRINCIPAL);
    expect(me.identity).toBeNull();
  });

  it('returns null without touching the database when the token has no usable claim', async () => {
    expect(await resolveMe({ sub: 'no-oid-no-upn' })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns null when nothing in the crawled data matches', async () => {
    stageQuery([], []);
    expect(await resolveMe({ oid: 'unknown', upn: 'nobody@example.com' })).toBeNull();
  });

  it('returns null when the Principals table does not exist yet', async () => {
    // A deployment whose migrations have not finished. /api/auth-me is a
    // bootstrap endpoint the UI needs for permission gating, so this must
    // degrade to "no mapping" rather than throw and break sign-in.
    query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

    expect(await resolveMe({ oid: PRINCIPAL.id })).toBeNull();
  });

  it('returns null and logs when the lookup fails for any other reason', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));

    expect(await resolveMe({ oid: PRINCIPAL.id })).toBeNull();
    // A connection failure is not a missing schema; it must be visible in the
    // logs rather than swallowed as "this user simply isn't in the data".
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
