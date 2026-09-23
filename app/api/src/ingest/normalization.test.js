import { describe, it, expect } from 'vitest';
import { coerceValue, normalizeRecords } from './normalization.js';
import { extendedAttributesBoundsError, EXT_ATTR_MAX_KEYS, EXT_ATTR_MAX_CHARS } from './normalization.js';

describe('coerceValue', () => {
  it('passes boolean true through unchanged', () => {
    expect(coerceValue(true)).toBe(true);
  });

  it('passes boolean false through unchanged', () => {
    expect(coerceValue(false)).toBe(false);
  });

  it('does not convert boolean to integer', () => {
    expect(coerceValue(true)).not.toBe(1);
    expect(coerceValue(false)).not.toBe(0);
  });

  it('converts empty string to null', () => {
    expect(coerceValue('')).toBeNull();
  });

  it('converts null to null', () => {
    expect(coerceValue(null)).toBeNull();
  });

  it('passes strings through unchanged', () => {
    expect(coerceValue('hello')).toBe('hello');
  });

  it('passes numbers through unchanged', () => {
    expect(coerceValue(42)).toBe(42);
  });

  it('serializes objects to JSON', () => {
    expect(coerceValue({ a: 1 })).toBe('{"a":1}');
  });
});

// ── identityExternalId resolution (T7.4) ─────────────────────────────────────

describe('normalizeRecords — identityExternalId resolution', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const coreColumns = ['resourceId', 'identityId', 'assignmentType', 'systemId'];
  const opts = { idGeneration: 'deterministic', idPrefix: 'Omada-sys1', systemId: 1 };

  it('resolves identityExternalId to a deterministic UUID in identityId', () => {
    const result = normalizeRecords(
      [{ resourceId: 'aaaa0000-0000-0000-0000-000000000000', identityExternalId: 'alice', assignmentType: 'Governed' }],
      coreColumns, opts
    );
    expect(result[0].identityId).toMatch(UUID_RE);
  });

  it('produces the same UUID on every call for the same input', () => {
    const rec = [{ resourceId: 'aaaa0000-0000-0000-0000-000000000000', identityExternalId: 'alice', assignmentType: 'Governed' }];
    const r1 = normalizeRecords(rec, coreColumns, opts)[0].identityId;
    const r2 = normalizeRecords(rec, coreColumns, opts)[0].identityId;
    expect(r1).toBe(r2);
  });

  it('does not overwrite an explicit identityId with external resolution', () => {
    const explicit = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const result = normalizeRecords(
      [{ resourceId: 'aaaa0000-0000-0000-0000-000000000000', identityId: explicit, identityExternalId: 'alice', assignmentType: 'Governed' }],
      coreColumns, opts
    );
    expect(result[0].identityId).toBe(explicit);
  });

  it('uses the same namespace as identity-members (sysPrefix-identities)', () => {
    // The identity assignment resolver and the identity-members resolver must
    // derive the same UUID from the same externalId — otherwise an assignment
    // row pushed before account linking would never match the IdentityMembers row
    // later pushed by the same crawler with identityExternalId.
    const assignmentResult = normalizeRecords(
      [{ resourceId: 'aaaa0000-0000-0000-0000-000000000000', identityExternalId: 'alice', assignmentType: 'Governed' }],
      coreColumns, opts
    );
    const memberResult = normalizeRecords(
      [{ identityExternalId: 'alice', principalId: 'bbbb0000-0000-0000-0000-000000000000' }],
      ['identityId', 'principalId'], opts
    );
    expect(assignmentResult[0].identityId).toBe(memberResult[0].identityId);
  });
});

// ── relatedPrincipalExternalId resolution (principal-relationships) ───────────

describe('normalizeRecords — relatedPrincipalExternalId resolution', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const coreColumns = ['principalId', 'relatedPrincipalId', 'relationshipType', 'systemId'];
  // systemPrefix is what the ingest route recovers by stripping the entity suffix
  // off idPrefix — pass it explicitly so both principal ids resolve in 'csv-sys1-principals'.
  const opts = { idGeneration: 'deterministic', idPrefix: 'csv-sys1', systemPrefix: 'csv-sys1', systemId: 1 };

  it('resolves both principal external ids into the principals namespace', () => {
    const result = normalizeRecords(
      [{ principalExternalId: 'agent-1', relatedPrincipalExternalId: 'owner-1', relationshipType: 'Owner' }],
      coreColumns, opts,
    );
    expect(result[0].principalId).toMatch(UUID_RE);
    expect(result[0].relatedPrincipalId).toMatch(UUID_RE);
    expect(result[0].principalId).not.toBe(result[0].relatedPrincipalId);
  });

  it('resolves relatedPrincipalExternalId to the SAME UUID a principals ingest would', () => {
    // The link's relatedPrincipalId must match the principal row keyed off the
    // same externalId, or the owner would never resolve to a real principal.
    const link = normalizeRecords(
      [{ principalExternalId: 'agent-1', relatedPrincipalExternalId: 'owner-1', relationshipType: 'Owner' }],
      coreColumns, opts,
    );
    const principal = normalizeRecords(
      [{ externalId: 'owner-1', displayName: 'Owner One' }],
      ['id', 'displayName'],
      { idGeneration: 'deterministic', idPrefix: 'csv-sys1-principals', systemPrefix: 'csv-sys1', systemId: 1 },
    );
    expect(link[0].relatedPrincipalId).toBe(principal[0].id);
  });

  it('does not overwrite an explicit relatedPrincipalId', () => {
    const explicit = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const result = normalizeRecords(
      [{ principalExternalId: 'agent-1', relatedPrincipalId: explicit, relatedPrincipalExternalId: 'owner-1', relationshipType: 'Owner' }],
      coreColumns, opts,
    );
    expect(result[0].relatedPrincipalId).toBe(explicit);
  });
});

describe('normalizeRecords — boolean fields', () => {
  it('preserves boolean true as boolean in core columns', () => {
    const result = normalizeRecords(
      [{ enabled: true, syncEnabled: false }],
      ['enabled', 'syncEnabled'],
    );
    expect(result[0].enabled).toBe(true);
    expect(result[0].syncEnabled).toBe(false);
  });

  it('does not coerce boolean to 0/1 (PGlite rejects integer for boolean columns)', () => {
    const result = normalizeRecords(
      [{ enabled: true }],
      ['enabled'],
    );
    expect(result[0].enabled).not.toBe(1);
  });
});

describe('normalizeRecords — extendedAttributes packing', () => {
  it('packs non-core fields into an extendedAttributes JSON string', () => {
    const result = normalizeRecords(
      [{ id: 'x', dept: 'sales', level: 3 }],
      ['id'],
    );
    expect(result[0]).not.toHaveProperty('dept');
    expect(JSON.parse(result[0].extendedAttributes)).toEqual({ dept: 'sales', level: 3 });
  });

  it('merges non-core fields over a pre-existing extendedAttributes string', () => {
    // extendedAttributes arrives as a core column holding a JSON string; the
    // extra non-core field must be merged into it, not clobber it.
    const result = normalizeRecords(
      [{ id: 'x', extendedAttributes: '{"a":1}', extra: 'b' }],
      ['id', 'extendedAttributes'],
    );
    expect(JSON.parse(result[0].extendedAttributes)).toEqual({ a: 1, extra: 'b' });
  });

  it('leaves records with no non-core fields without an extendedAttributes key', () => {
    const result = normalizeRecords(
      [{ id: 'x', name: 'n' }],
      ['id', 'name'],
    );
    expect(result[0]).not.toHaveProperty('extendedAttributes');
  });
});

describe('normalizeRecords — context-member externalId resolution', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // The CSV crawler sends context-members with idPrefix "<sys>-context-members".
  const memberOpts  = { idGeneration: 'deterministic', idPrefix: 'Omada-context-members', systemId: 1 };
  const memberCols  = ['contextId', 'memberId', 'memberType', 'addedBy'];

  it('resolves contextExternalId to a deterministic UUID in contextId', () => {
    const r = normalizeRecords(
      [{ contextExternalId: 'OU123|JT456', memberExternalId: 'alice', memberType: 'Identity', addedBy: 'sync' }],
      memberCols, memberOpts
    );
    expect(r[0].contextId).toMatch(UUID_RE);
    expect(r[0].memberId).toMatch(UUID_RE);
  });

  it('a pipe in the context key is handled (it is hashed, not split)', () => {
    const piped  = normalizeRecords([{ contextExternalId: 'OU|JT', memberExternalId: 'a', memberType: 'Identity' }], memberCols, memberOpts);
    const plain  = normalizeRecords([{ contextExternalId: 'OUJT',  memberExternalId: 'a', memberType: 'Identity' }], memberCols, memberOpts);
    expect(piped[0].contextId).toMatch(UUID_RE);
    // Different keys → different ids (no truncation/collision on the pipe).
    expect(piped[0].contextId).not.toBe(plain[0].contextId);
  });

  it('member contextId matches the id the Contexts endpoint generates for the same key (incl. a pipe)', () => {
    // This is the FK that was broken: a ContextMember must resolve to the exact
    // UUID the Position context got. Contexts are sent with idPrefix "<sys>-contexts".
    const posKey = 'OU123|JT456';
    const contextOpts = { idGeneration: 'deterministic', idPrefix: 'Omada-contexts', systemId: 1 };
    const ctx = normalizeRecords(
      [{ externalId: posKey, displayName: 'Pos', variant: 'synced', targetType: 'Identity', contextType: 'Position' }],
      ['id', 'externalId', 'displayName', 'variant', 'targetType', 'contextType', 'systemId'], contextOpts
    );
    const mem = normalizeRecords(
      [{ contextExternalId: posKey, memberExternalId: 'alice', memberType: 'Identity' }],
      memberCols, memberOpts
    );
    expect(mem[0].contextId).toBe(ctx[0].id);
  });

  it('memberId namespace depends on memberType (Identity → identities)', () => {
    const member   = normalizeRecords([{ contextExternalId: 'c', memberExternalId: 'alice', memberType: 'Identity' }], memberCols, memberOpts);
    // An identity sent to ingest/identities (idPrefix "<sys>-identities") gets this id.
    const identity = normalizeRecords([{ externalId: 'alice', displayName: 'A' }], ['id', 'externalId', 'displayName'], { idGeneration: 'deterministic', idPrefix: 'Omada-identities', systemId: 1 });
    expect(member[0].memberId).toBe(identity[0].id);
  });

  it('does not overwrite an explicit contextId', () => {
    const explicit = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const r = normalizeRecords(
      [{ contextId: explicit, contextExternalId: 'OU|JT', memberExternalId: 'a', memberType: 'Identity' }],
      memberCols, memberOpts
    );
    expect(r[0].contextId).toBe(explicit);
  });

  it('honours an explicit systemPrefix when the prefix contains a hyphen (regression)', () => {
    // A hyphenated systemType used to break here: the old idPrefix.split('-')[0]
    // recovered only the first segment, so members resolved their contextId
    // under "<first>-contexts" while the Contexts endpoint created rows under
    // the full "<first>-<rest>-contexts" — every contextId mismatched and the
    // upsert failed with ContextMembers_contextId_fkey. The route now strips the
    // known entity suffix and passes the full systemPrefix.
    const sys = 'Two-Part';
    const ctx = normalizeRecords(
      [{ externalId: 'OU123', displayName: 'OU', variant: 'synced', targetType: 'Identity', contextType: 'OrgUnit' }],
      ['id', 'externalId', 'displayName', 'variant', 'targetType', 'contextType', 'systemId'],
      { idGeneration: 'deterministic', idPrefix: `${sys}-contexts`, systemId: 1 }
    );
    const memberCols2 = ['contextId', 'memberId', 'memberType'];
    const withPrefix = normalizeRecords(
      [{ contextExternalId: 'OU123', memberExternalId: 'alice', memberType: 'Identity' }],
      memberCols2,
      { idGeneration: 'deterministic', idPrefix: `${sys}-context-members`, systemPrefix: sys, systemId: 1 }
    );
    // With the recovered systemPrefix the member resolves to the exact context id.
    expect(withPrefix[0].contextId).toBe(ctx[0].id);

    // And the old fallback (no systemPrefix → split on first hyphen) would NOT.
    const oldBehaviour = normalizeRecords(
      [{ contextExternalId: 'OU123', memberExternalId: 'alice', memberType: 'Identity' }],
      memberCols2,
      { idGeneration: 'deterministic', idPrefix: `${sys}-context-members`, systemId: 1 }
    );
    expect(oldBehaviour[0].contextId).not.toBe(ctx[0].id);
  });
});

describe('normalizeRecords — context parentExternalId resolution', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Contexts are ingested with idPrefix "<sys>-contexts".
  const contextOpts = { idGeneration: 'deterministic', idPrefix: 'Omada-contexts', systemId: 1 };
  const contextCols = ['id', 'externalId', 'displayName', 'variant', 'targetType', 'contextType', 'parentContextId', 'systemId'];

  it('resolves a context parentExternalId to a deterministic UUID in parentContextId', () => {
    const r = normalizeRecords(
      [{ externalId: 'child', displayName: 'Child', contextType: 'OrgUnit', parentExternalId: 'root' }],
      contextCols, contextOpts
    );
    expect(r[0].parentContextId).toMatch(UUID_RE);
  });

  it('child parentContextId matches the id the Contexts endpoint generates for the parent (the FK that was broken)', () => {
    // A parented context tree must link child→parent by the exact UUID the parent
    // context row got. Both are sent with idPrefix "<sys>-contexts", so the child's
    // resolved parentContextId has to equal the parent's generated id.
    const parentKey = 'root';
    const parent = normalizeRecords(
      [{ externalId: parentKey, displayName: 'Root', contextType: 'OrgUnit' }],
      contextCols, contextOpts
    );
    const child = normalizeRecords(
      [{ externalId: 'child', displayName: 'Child', contextType: 'OrgUnit', parentExternalId: parentKey }],
      contextCols, contextOpts
    );
    expect(child[0].parentContextId).toBe(parent[0].id);
  });

  it('does NOT mis-resolve a context parent into parentResourceId (the bug)', () => {
    // Before the fix, every deterministic parentExternalId became a parentResourceId
    // under "<sys>-resources" — wrong table, wrong namespace — so the context
    // hierarchy silently never persisted (the parent survived only as raw text in
    // extendedAttributes).
    const r = normalizeRecords(
      [{ externalId: 'child', displayName: 'Child', contextType: 'OrgUnit', parentExternalId: 'root' }],
      contextCols, contextOpts
    );
    expect(r[0].parentResourceId).toBeUndefined();
  });

  it('does not overwrite an explicit parentContextId', () => {
    const explicit = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const r = normalizeRecords(
      [{ externalId: 'child', parentContextId: explicit, parentExternalId: 'root', contextType: 'OrgUnit' }],
      contextCols, contextOpts
    );
    expect(r[0].parentContextId).toBe(explicit);
  });

  it('still resolves a resource-relationship parentExternalId to parentResourceId (table has no parentContextId column)', () => {
    // Regression guard: the resource-relationships table carries parentResourceId,
    // not parentContextId, so parentExternalId must keep resolving into
    // "<sys>-resources" and match the id the Resources endpoint generates.
    const relOpts = { idGeneration: 'deterministic', idPrefix: 'Omada-resource-relationships', systemPrefix: 'Omada', systemId: 1 };
    const relCols = ['parentResourceId', 'childResourceId', 'relationshipType', 'systemId'];
    const r = normalizeRecords(
      [{ parentExternalId: 'grp', childExternalId: 'sub', relationshipType: 'Contains' }],
      relCols, relOpts
    );
    expect(r[0].parentResourceId).toMatch(UUID_RE);
    expect(r[0].parentContextId).toBeUndefined();
    const resource = normalizeRecords(
      [{ externalId: 'grp', displayName: 'Grp' }],
      ['id', 'externalId', 'displayName'],
      { idGeneration: 'deterministic', idPrefix: 'Omada-resources', systemId: 1 }
    );
    expect(r[0].parentResourceId).toBe(resource[0].id);
  });
});

// ── extendedAttributes bounds (SEC-2026-09 L-16) ─────────────────────────────

describe('extendedAttributesBoundsError', () => {
  const packed = (n) => JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1])));

  it('ships limits far above any shipped crawler (500 keys, 512 KB)', () => {
    expect(EXT_ATTR_MAX_KEYS).toBe(500);
    expect(EXT_ATTR_MAX_CHARS).toBe(512 * 1024);
  });

  it('accepts exactly the key limit and refuses one more, naming the record', () => {
    expect(extendedAttributesBoundsError([{ extendedAttributes: packed(3) }], 3)).toBeNull();
    expect(extendedAttributesBoundsError([{}, { extendedAttributes: packed(4) }], 3))
      .toBe('Record 1: extendedAttributes has more than 3 keys');
  });

  it('accepts exactly the size limit and refuses one character more', () => {
    const value = JSON.stringify({ a: 'x'.repeat(10) }); // 18 characters
    expect(extendedAttributesBoundsError([{ extendedAttributes: value }], 500, value.length)).toBeNull();
    expect(extendedAttributesBoundsError([{ extendedAttributes: value }], 500, value.length - 1))
      .toBe(`Record 0: extendedAttributes exceeds ${value.length - 1} characters`);
  });

  it('ignores records without packed attributes and non-object JSON', () => {
    expect(extendedAttributesBoundsError([{ displayName: 'x' }, { extendedAttributes: '"just a string"' }], 0)).toBeNull();
  });
});

// ── binary columns ───────────────────────────────────────────────────────────
//
// A bytea column is fed a Buffer; node-postgres binds that directly. If the
// base64 string reached the driver unconverted it would be stored as the TEXT
// of the encoding rather than the image, which is why these assert the decoded
// byte values and not merely "something changed".
describe('normalizeRecords — binary columns', () => {
  const cols = ['id', 'displayName', 'photo', 'photoContentType'];

  it('decodes a base64 photo into the original bytes', () => {
    const [out] = normalizeRecords([{ id: 'u1', photo: 'AQID' }], cols);
    expect(Buffer.isBuffer(out.photo)).toBe(true);
    expect([...out.photo]).toEqual([1, 2, 3]);
  });

  it('leaves a non-binary column holding base64-looking text as a string', () => {
    // displayName is not a binary column. Decoding by value-shape rather than
    // by column name would mangle ordinary names that happen to look like
    // base64 — 'QUJD' is a perfectly legal display name.
    const [out] = normalizeRecords([{ id: 'u1', displayName: 'QUJD' }], cols);
    expect(out.displayName).toBe('QUJD');
  });

  it('keeps an explicit null photo as null rather than an empty buffer', () => {
    // This is the "we asked, this user has no photo" record. An empty Buffer
    // would be a stored-but-blank image, which reads back as a photo that
    // exists and renders broken, instead of falling back to the initial.
    const [out] = normalizeRecords([{ id: 'u1', photo: null }], cols);
    expect(out.photo).toBeNull();
  });

  it('does not invent a photo column when the record has none', () => {
    // Partial principal updates must not touch columns they omit.
    const [out] = normalizeRecords([{ id: 'u1', displayName: 'Ada' }], cols);
    expect('photo' in out).toBe(false);
  });
});
