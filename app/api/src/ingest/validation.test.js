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
    expect(result.errors.some(e => /records must be an array/.test(e))).toBe(true);
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
    for (const t of ['Direct', 'Indirect', 'Eligible', 'Owner', 'Governed']) {
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
    for (const t of ['Contains', 'GrantsAccessTo']) {
      const result = validateRecords([{ ...validRel, relationshipType: t }], 'resource-relationships');
      expect(result.valid, `Expected valid for relationshipType=${t}`).toBe(true);
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
