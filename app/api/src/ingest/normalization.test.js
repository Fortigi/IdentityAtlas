import { describe, it, expect } from 'vitest';
import { coerceValue, normalizeRecords } from './normalization.js';

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
