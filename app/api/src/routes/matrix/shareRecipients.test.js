// Unit tests for the share-recipient rules (#1166) — pure, no DB.
//
// These two functions are the whole access decision for a shared matrix: what
// gets stored as "the people this is for", and which claims a signed-in caller
// is recognised by. Inputs are chosen to discriminate — mixed case, padding,
// duplicates that differ only in case, and each of the four sign-in claims in
// isolation — so an implementation that skipped normalisation, deduplicated on
// the raw string, or read only one claim fails here rather than in production.

import { describe, it, expect } from 'vitest';
import {
  normalizeRecipients,
  identityKeysOf,
  objectIdOf,
  normalizeUserKey,
  MAX_RECIPIENTS,
} from './shareRecipients.js';

const OID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('normalizeUserKey', () => {
  it('lower-cases and trims a sign-in name, and rejects a non-string', () => {
    expect(normalizeUserKey('  Manager@Contoso.COM ')).toBe('manager@contoso.com');
    for (const bad of [null, undefined, 42, {}, ['a@b.c']]) expect(normalizeUserKey(bad)).toBe('');
  });
});

describe('normalizeRecipients', () => {
  it('keeps the picked directory row, normalising the key it will be matched on', () => {
    const rows = normalizeRecipients([
      { principalId: OID.toUpperCase(), userKey: ' Manager@Contoso.com ', displayName: '  Ann Manager  ' },
    ]);
    expect(rows).toEqual([
      { userKey: 'manager@contoso.com', principalId: OID, displayName: 'Ann Manager' },
    ]);
  });

  it('accepts a bare sign-in name so an API caller need not look anyone up', () => {
    expect(normalizeRecipients(['Owner@Contoso.com'])).toEqual([
      { userKey: 'owner@contoso.com', principalId: null, displayName: null },
    ]);
  });

  it('collapses duplicates that differ only in case, keeping the first row intact', () => {
    const rows = normalizeRecipients([
      { userKey: 'ann@contoso.com', principalId: OID, displayName: 'Ann' },
      { userKey: 'ANN@CONTOSO.COM', principalId: null, displayName: 'Ann again' },
    ]);
    expect(rows).toHaveLength(1);
    // The richer first entry wins — the later bare duplicate must not blank it.
    expect(rows[0]).toEqual({ userKey: 'ann@contoso.com', principalId: OID, displayName: 'Ann' });
  });

  it('drops entries with no usable sign-in name rather than storing an empty key', () => {
    expect(normalizeRecipients([
      { userKey: '   ' }, { userKey: null }, { displayName: 'No key' },
      null, undefined, 42, '', '   ',
    ])).toEqual([]);
  });

  it('drops a principalId that is not a uuid instead of failing the insert', () => {
    const [row] = normalizeRecipients([{ principalId: 'not-a-uuid', userKey: 'a@b.com' }]);
    expect(row.principalId).toBeNull();
  });

  it('keeps a padded principalId — the uuid pattern is anchored, so it must be trimmed first', () => {
    const [row] = normalizeRecipients([{ principalId: `  ${OID}  `, userKey: 'a@b.com' }]);
    expect(row.principalId).toBe(OID);
  });

  it('returns nothing for a payload that is not an array', () => {
    for (const bad of [undefined, null, 'ann@contoso.com', { userKey: 'a@b.com' }]) {
      expect(normalizeRecipients(bad)).toEqual([]);
    }
  });

  it('caps a pasted list at MAX_RECIPIENTS, keeping the first entries', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 5 }, (_, i) => `user${i}@contoso.com`);
    const rows = normalizeRecipients(many);
    expect(rows).toHaveLength(MAX_RECIPIENTS);
    expect(rows[0].userKey).toBe('user0@contoso.com');
    expect(rows.at(-1).userKey).toBe(`user${MAX_RECIPIENTS - 1}@contoso.com`);
  });

  it('truncates an over-long display name', () => {
    const [row] = normalizeRecipients([{ userKey: 'a@b.com', displayName: 'x'.repeat(500) }]);
    expect(row.displayName).toHaveLength(200);
  });
});

describe('identityKeysOf', () => {
  // Which claim carries the sign-in name differs per tenant and token version;
  // each is asserted alone so dropping any one of them fails a test.
  it.each([
    ['email', { email: 'Ann@Contoso.com' }],
    ['upn', { upn: 'Ann@Contoso.com' }],
    ['preferred_username', { preferred_username: 'Ann@Contoso.com' }],
    ['unique_name', { unique_name: 'Ann@Contoso.com' }],
  ])('recognises a caller by their %s claim alone', (_claim, user) => {
    expect(identityKeysOf(user)).toEqual(['ann@contoso.com']);
  });

  it('collects every distinct claim when a token carries several', () => {
    const keys = identityKeysOf({ email: 'ann@contoso.com', upn: 'a.manager@contoso.com', preferred_username: 'ANN@CONTOSO.COM' });
    expect(keys.sort()).toEqual(['a.manager@contoso.com', 'ann@contoso.com']);
  });

  it('returns nothing for an unauthenticated caller — matching no recipient row', () => {
    expect(identityKeysOf(undefined)).toEqual([]);
    expect(identityKeysOf({})).toEqual([]);
    expect(identityKeysOf({ name: 'Ann Manager' })).toEqual([]);   // a display name is not a sign-in name
  });
});

describe('objectIdOf', () => {
  it('returns the token oid, lower-cased for comparison with a stored uuid', () => {
    expect(objectIdOf({ oid: OID.toUpperCase() })).toBe(OID);
  });

  it('returns null when the token has no usable oid', () => {
    for (const user of [undefined, {}, { oid: '' }, { oid: 'not-a-uuid' }, { oid: 12345 }]) {
      expect(objectIdOf(user)).toBeNull();
    }
  });
});
