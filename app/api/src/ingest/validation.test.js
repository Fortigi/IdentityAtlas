/**
 * Unit tests for ingest/validation.js
 *
 * Run: npm test (from app/api/)
 */

import { describe, it, expect } from 'vitest';
import { validateEnvelope, validateRecords } from './validation.js';

// ── validateEnvelope ──────────────────────────────────────────────────────────

describe('validateEnvelope', () => {
  const validBase = {
    systemId: '11111111-1111-1111-1111-111111111111',
    records: [{ displayName: 'Test' }],
  };

  it('accepts a minimal valid envelope', () => {
    const result = validateEnvelope(validBase, 'principals');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects null body', () => {
    const result = validateEnvelope(null, 'principals');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/JSON object/);
  });

  it('rejects non-object body', () => {
    const result = validateEnvelope('a string', 'principals');
    expect(result.valid).toBe(false);
  });

  it('requires systemId for non-systems entity types', () => {
    const { systemId: _, ...noId } = validBase;
    const result = validateEnvelope(noId, 'principals');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('systemId is required');
  });

  it('does not require systemId for systems entity type', () => {
    const body = { records: [{ displayName: 'S', systemType: 'EntraID' }] };
    const result = validateEnvelope(body, 'systems');
    expect(result.valid).toBe(true);
  });

  it('rejects missing records field', () => {
    const result = validateEnvelope({ systemId: validBase.systemId }, 'principals');
    expect(result.valid).toBe(false);
    // validateEnvelope treats undefined/null `records` as an empty array
    // (PowerShell's ConvertTo-Json serialises @() as null, so we have to
    // be lenient there). A body with no records AND no deletedIds still
    // fails, but with "cannot be empty" rather than "must be an array".
    expect(result.errors.some(e => /records.*cannot be empty|records must be an array/.test(e))).toBe(true);
  });

  it('rejects empty records array', () => {
    const result = validateEnvelope({ ...validBase, records: [] }, 'principals');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /cannot be empty/.test(e))).toBe(true);
  });

  it('rejects records array exceeding 50 000', () => {
    const big = { ...validBase, records: new Array(50001).fill({ displayName: 'x' }) };
    const result = validateEnvelope(big, 'principals');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /50,000/.test(e))).toBe(true);
  });

  it('accepts syncMode "full"', () => {
    const result = validateEnvelope({ ...validBase, syncMode: 'full' }, 'principals');
    expect(result.valid).toBe(true);
  });

  it('accepts syncMode "delta"', () => {
    const result = validateEnvelope({ ...validBase, syncMode: 'delta' }, 'principals');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid syncMode', () => {
    const result = validateEnvelope({ ...validBase, syncMode: 'partial' }, 'principals');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /syncMode/.test(e))).toBe(true);
  });

  it('accepts idGeneration "native"', () => {
    const result = validateEnvelope({ ...validBase, idGeneration: 'native' }, 'principals');
    expect(result.valid).toBe(true);
  });

  it('accepts idGeneration "deterministic" with idPrefix', () => {
    const result = validateEnvelope(
      { ...validBase, idGeneration: 'deterministic', idPrefix: 'sys1' },
      'principals'
    );
    expect(result.valid).toBe(true);
  });

  it('rejects idGeneration "deterministic" without idPrefix', () => {
    const result = validateEnvelope(
      { ...validBase, idGeneration: 'deterministic' },
      'principals'
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /idPrefix/.test(e))).toBe(true);
  });

  it('rejects unknown idGeneration value', () => {
    const result = validateEnvelope({ ...validBase, idGeneration: 'random' }, 'principals');
    expect(result.valid).toBe(false);
  });
});

// ── validateRecords — principals ──────────────────────────────────────────────

describe('validateRecords — principals', () => {
  const validPrincipal = {
    id: '22222222-2222-2222-2222-222222222222',
    displayName: 'Alice Johnson',
    principalType: 'User',
  };

  it('accepts a valid principal record', () => {
    const result = validateRecords([validPrincipal], 'principals');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('requires displayName', () => {
    const { displayName: _, ...noName } = validPrincipal;
    const result = validateRecords([noName], 'principals');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /displayName/.test(e))).toBe(true);
  });

  it('rejects empty displayName', () => {
    const result = validateRecords([{ ...validPrincipal, displayName: '' }], 'principals');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid UUID in id field', () => {
    const result = validateRecords([{ ...validPrincipal, id: 'not-a-uuid' }], 'principals');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /UUID/.test(e))).toBe(true);
  });

  it('allows missing id when idGeneration is deterministic', () => {
    const { id: _, ...noId } = validPrincipal;
    const result = validateRecords([noId], 'principals', 'deterministic');
    expect(result.valid).toBe(true);
  });

  it('allows non-UUID id when idGeneration is deterministic', () => {
    const result = validateRecords(
      [{ ...validPrincipal, id: 'EMPLOYEE-001' }],
      'principals',
      'deterministic'
    );
    expect(result.valid).toBe(true);
  });

  it('rejects invalid principalType enum value', () => {
    const result = validateRecords(
      [{ ...validPrincipal, principalType: 'Robot' }],
      'principals'
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /principalType/.test(e))).toBe(true);
  });

  it('accepts all valid principalType values', () => {
    const types = ['User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox'];
    for (const t of types) {
      const result = validateRecords([{ ...validPrincipal, principalType: t }], 'principals');
      expect(result.valid, `Expected valid for principalType=${t}`).toBe(true);
    }
  });

  it('rejects displayName exceeding 500 chars', () => {
    const result = validateRecords(
      [{ ...validPrincipal, displayName: 'A'.repeat(501) }],
      'principals'
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /max length/.test(e))).toBe(true);
  });

  it('rejects non-string displayName', () => {
    const result = validateRecords([{ ...validPrincipal, displayName: 123 }], 'principals');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid UUID in managerId', () => {
    const result = validateRecords(
      [{ ...validPrincipal, managerId: 'not-a-uuid' }],
      'principals'
    );
    expect(result.valid).toBe(false);
  });

  it('accepts valid UUID in managerId', () => {
    const result = validateRecords(
      [{ ...validPrincipal, managerId: '33333333-3333-3333-3333-333333333333' }],
      'principals'
    );
    expect(result.valid).toBe(true);
  });
});

// ── validateRecords — resource-assignments ────────────────────────────────────

describe('validateRecords — resource-assignments', () => {
  const validAssignment = {
    resourceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    principalId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    assignmentType: 'Direct',
  };

  it('accepts a valid assignment record', () => {
    const result = validateRecords([validAssignment], 'resource-assignments');
    expect(result.valid).toBe(true);
  });

  it('requires resourceId', () => {
    const { resourceId: _, ...noRes } = validAssignment;
    const result = validateRecords([noRes], 'resource-assignments');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /resourceId/.test(e))).toBe(true);
  });

  it('requires principalId', () => {
    const { principalId: _, ...noPrinc } = validAssignment;
    const result = validateRecords([noPrinc], 'resource-assignments');
    expect(result.valid).toBe(false);
  });

  it('requires assignmentType', () => {
    const { assignmentType: _, ...noType } = validAssignment;
    const result = validateRecords([noType], 'resource-assignments');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid assignmentType', () => {
    const result = validateRecords(
      [{ ...validAssignment, assignmentType: 'Temporary' }],
      'resource-assignments'
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /assignmentType/.test(e))).toBe(true);
  });

  it('accepts all valid assignmentType values', () => {
    // The assignment-model redesign narrowed assignmentType to the three
    // universal "how" values (see ASSIGNMENT_TYPES in validation.js + the hard
    // rule in assignmentTypes.guard.test.js).
    const allTypes = ['Direct', 'Indirect', 'Eligible'];
    for (const t of allTypes) {
      const result = validateRecords([{ ...validAssignment, assignmentType: t }], 'resource-assignments');
      expect(result.valid, `Expected valid for assignmentType=${t}`).toBe(true);
    }
  });
});

// ── validateRecords — resource-relationships ──────────────────────────────────

describe('validateRecords — resource-relationships', () => {
  const validRel = {
    parentResourceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    childResourceId:  'dddddddd-dddd-dddd-dddd-dddddddddddd',
    relationshipType: 'Contains',
  };

  it('accepts a valid relationship record', () => {
    const result = validateRecords([validRel], 'resource-relationships');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid relationshipType', () => {
    const result = validateRecords(
      [{ ...validRel, relationshipType: 'Owns' }],
      'resource-relationships'
    );
    expect(result.valid).toBe(false);
  });

  it('accepts all valid relationshipType values', () => {
    // Keep this in sync with RELATIONSHIP_TYPES in validation.js.
    const allTypes = ['Contains', 'GrantsAccessTo', 'DelegatesScope', 'HasAppRole', 'HasOwnership', 'HasAppOwnership'];
    for (const t of allTypes) {
      const result = validateRecords([{ ...validRel, relationshipType: t }], 'resource-relationships');
      expect(result.valid, `Expected valid for relationshipType=${t}`).toBe(true);
    }
  });
});

// ── validateRecords — principal-relationships ─────────────────────────────────

describe('validateRecords — principal-relationships', () => {
  const validPR = {
    principalId:        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    relatedPrincipalId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    relationshipType:   'Owner',
  };

  it('accepts a valid Owner record', () => {
    expect(validateRecords([validPR], 'principal-relationships').valid).toBe(true);
  });

  it('accepts a valid Sponsor record', () => {
    expect(validateRecords([{ ...validPR, relationshipType: 'Sponsor' }], 'principal-relationships').valid).toBe(true);
  });

  it('rejects an unknown relationshipType', () => {
    expect(validateRecords([{ ...validPR, relationshipType: 'Manager' }], 'principal-relationships').valid).toBe(false);
  });

  it('rejects a record missing both principalId and its external alias', () => {
    const r = validateRecords([{ relatedPrincipalId: validPR.relatedPrincipalId, relationshipType: 'Owner' }], 'principal-relationships');
    expect(r.valid).toBe(false);
  });

  it('accepts external-id aliases in place of the UUIDs', () => {
    const r = validateRecords(
      [{ principalExternalId: 'agent-1', relatedPrincipalExternalId: 'owner-1', relationshipType: 'Owner' }],
      'principal-relationships',
    );
    expect(r.valid).toBe(true);
  });
});

// ── validateRecords — resources governanceResource ──────────────────────────

describe('validateRecords — resources governanceResource', () => {
  it('accepts a boolean governanceResource on a governance resource', () => {
    const r = validateRecords(
      [{ displayName: 'Marketing role', resourceType: 'BusinessRole', governanceResource: true }],
      'resources',
    );
    expect(r.valid).toBe(true);
  });
});

// ── validateRecords — resource-assignments XOR check (T7.3) ──────────────────

describe('validateRecords — resource-assignments XOR check', () => {
  const validAssignment = {
    resourceId:    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    principalId:   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    assignmentType: 'Direct',
  };

  it('rejects a record that carries identityId on the principal endpoint', () => {
    const result = validateRecords([{
      ...validAssignment,
      identityId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    }], 'resource-assignments');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /resource-assignments-identity/.test(e))).toBe(true);
  });

  it('rejects a record that carries identityExternalId on the principal endpoint', () => {
    const result = validateRecords([{
      ...validAssignment,
      identityExternalId: 'alice',
    }], 'resource-assignments');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /resource-assignments-identity/.test(e))).toBe(true);
  });

  it('accepts a clean principal-only record (no identity side-fields)', () => {
    const result = validateRecords([validAssignment], 'resource-assignments');
    expect(result.valid).toBe(true);
  });
});

// ── validateRecords — resource-assignments-identity (T7.1) ───────────────────

describe('validateRecords — resource-assignments-identity', () => {
  const validIdentityAssignment = {
    resourceId:    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    identityId:    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    assignmentType: 'Direct',
  };

  it('accepts a valid identity assignment with explicit identityId (T7.1)', () => {
    const result = validateRecords([validIdentityAssignment], 'resource-assignments-identity');
    expect(result.valid).toBe(true);
  });

  it('accepts a record using identityExternalId in place of identityId', () => {
    const { identityId: _, ...withExternal } = validIdentityAssignment;
    const result = validateRecords([{ ...withExternal, identityExternalId: 'alice' }], 'resource-assignments-identity');
    expect(result.valid).toBe(true);
  });

  it('accepts a record using resourceExternalId in place of resourceId', () => {
    const { resourceId: _, ...withExternal } = validIdentityAssignment;
    const result = validateRecords([{ ...withExternal, resourceExternalId: 'role-123' }], 'resource-assignments-identity');
    expect(result.valid).toBe(true);
  });

  it('requires assignmentType', () => {
    const { assignmentType: _, ...noType } = validIdentityAssignment;
    const result = validateRecords([noType], 'resource-assignments-identity');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /assignmentType/.test(e))).toBe(true);
  });

  it('requires one of resourceId / resourceExternalId', () => {
    const { resourceId: _, ...noRes } = validIdentityAssignment;
    const result = validateRecords([noRes], 'resource-assignments-identity');
    expect(result.valid).toBe(false);
  });

  it('requires one of identityId / identityExternalId', () => {
    const { identityId: _, ...noId } = validIdentityAssignment;
    const result = validateRecords([noId], 'resource-assignments-identity');
    expect(result.valid).toBe(false);
  });

  it('rejects an invalid assignmentType value', () => {
    const result = validateRecords([{ ...validIdentityAssignment, assignmentType: 'NotAType' }], 'resource-assignments-identity');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /assignmentType/.test(e))).toBe(true);
  });

  it('rejects a malformed identityId UUID', () => {
    const result = validateRecords([{ ...validIdentityAssignment, identityId: 'not-a-uuid' }], 'resource-assignments-identity');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /UUID/.test(e))).toBe(true);
  });
});

// ── ENTITY_KEY_MAP — resource-assignments-identity key columns (T7.11) ────────

describe('ENTITY_KEY_MAP — resource-assignments-identity', () => {
  it('uses identityId as key column, not principalId', async () => {
    const { ENTITY_KEY_MAP } = await import('./validation.js');
    expect(ENTITY_KEY_MAP['resource-assignments-identity'])
      .toEqual(['resourceId', 'identityId', 'assignmentType', 'governed']);
  });

  it('principal endpoint still uses principalId as key column (T7.2)', async () => {
    const { ENTITY_KEY_MAP } = await import('./validation.js');
    expect(ENTITY_KEY_MAP['resource-assignments'])
      .toEqual(['resourceId', 'principalId', 'assignmentType', 'governed']);
  });
});

// ── ENTITY_SCOPE_MAP — assignment reconcile partition ────────────────────────
// Assignment-model redesign, phase 1: the full-sync reconcile delete may
// partition on the resource axis. Both assignment scopes accept resourceType in
// addition to assignmentType. assignmentType must remain first/present so a
// crawler that sends only it keeps the exact same delete scope as before.

describe('ENTITY_SCOPE_MAP — assignment scopes', () => {
  it('both assignment scopes accept assignmentType and resourceType', async () => {
    const { ENTITY_SCOPE_MAP } = await import('./validation.js');
    for (const entity of ['resource-assignments', 'resource-assignments-identity']) {
      expect(ENTITY_SCOPE_MAP[entity]).toContain('assignmentType');
      expect(ENTITY_SCOPE_MAP[entity]).toContain('resourceType');
    }
  });
});

// ── validateRecords — unknown entity type ─────────────────────────────────────

describe('validateRecords — unknown entity type', () => {
  it('returns invalid for unknown entity type', () => {
    const result = validateRecords([{ displayName: 'x' }], 'widgets');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Unknown entity type/);
  });
});

// ── validateRecords — error cap ───────────────────────────────────────────────

describe('validateRecords — error cap', () => {
  it('stops reporting after 10 errors', () => {
    // 20 records all missing required displayName
    const bad = new Array(20).fill({ principalType: 'User' });
    const result = validateRecords(bad, 'principals');
    expect(result.valid).toBe(false);
    // Should have exactly 11 messages: 10 real + 1 "and more errors" message
    expect(result.errors).toHaveLength(11);
    expect(result.errors[10]).toMatch(/stopped after/);
  });
});

// ── validateRecords — principal-activity ─────────────────────────────────────

describe('validateRecords — principal-activity', () => {
  const valid = {
    principalId:  '22222222-2222-2222-2222-222222222222',
    resourceId:   '00000000-0000-0000-0000-000000000000', // aggregate sentinel
    activityType: 'SignIn',
    lastSignInDateTime: '2026-04-18T12:34:56Z',
  };

  it('accepts an aggregate (resourceId = sentinel) SignIn record', () => {
    const result = validateRecords([valid], 'principal-activity');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a per-(principal,app) SignInPerApp record', () => {
    const r = {
      principalId:  '22222222-2222-2222-2222-222222222222',
      resourceId:   '33333333-3333-3333-3333-333333333333',
      activityType: 'SignInPerApp',
      lastSignInDateTime: '2026-04-18T12:34:56Z',
      lastSuccessfulSignInDateTime: '2026-04-18T12:34:56Z',
      signInCount: 5,
    };
    expect(validateRecords([r], 'principal-activity').valid).toBe(true);
  });

  it('requires principalId', () => {
    const { principalId: _, ...noPid } = valid;
    const result = validateRecords([noPid], 'principal-activity');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /principalId/.test(e))).toBe(true);
  });

  it('requires activityType', () => {
    const { activityType: _, ...noType } = valid;
    const result = validateRecords([noType], 'principal-activity');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /activityType/.test(e))).toBe(true);
  });

  it('rejects a malformed UUID in principalId', () => {
    const result = validateRecords([{ ...valid, principalId: 'nope' }], 'principal-activity');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /UUID/.test(e))).toBe(true);
  });

  it('rejects a malformed UUID in resourceId', () => {
    const result = validateRecords([{ ...valid, resourceId: 'nope' }], 'principal-activity');
    expect(result.valid).toBe(false);
  });

  it('exports AGG_RESOURCE_ID matching the migration DEFAULT', async () => {
    // The sentinel is cross-boundary: the migration DEFAULT, the ingest
    // validator, the crawler PS1 and the risk-engine all hardcode it. If
    // they ever diverge, aggregate rows won't match their own unique key
    // and silently duplicate. The migration value is authoritative.
    const { AGG_RESOURCE_ID } = await import('./validation.js');
    expect(AGG_RESOURCE_ID).toBe('00000000-0000-0000-0000-000000000000');
  });
});
