/**
 * Unit tests for ingest/validation.helpers.js
 *
 * These pin the individual pure validators extracted from validation.js so the
 * behaviour of validateEnvelope / validateRecords is covered branch-by-branch.
 *
 * Run: npm test (from app/api/)
 */

import { describe, it, expect } from 'vitest';
import {
  isBlank,
  validateSystemId,
  validateRecordsArray,
  validateDeletedIdsArray,
  validateEnvelopeOptions,
  validateRequiredFields,
  validateRequiredOneOf,
  validateAssignmentXor,
  validateIdField,
  validateFieldValue,
  validateFieldConstraints,
  validateRecord,
} from './validation.helpers.js';

const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ── isBlank ──────────────────────────────────────────────────────────────────

describe('isBlank', () => {
  it('treats undefined, null and "" as blank', () => {
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank(null)).toBe(true);
    expect(isBlank('')).toBe(true);
  });

  it('treats any other value as present', () => {
    expect(isBlank('x')).toBe(false);
    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
  });
});

// ── validateSystemId ─────────────────────────────────────────────────────────

describe('validateSystemId', () => {
  it('never requires systemId for the systems endpoint', () => {
    expect(validateSystemId({}, 'systems')).toEqual([]);
  });

  it('requires systemId for other endpoints when absent', () => {
    expect(validateSystemId({}, 'principals')).toEqual(['systemId is required']);
    expect(validateSystemId({ systemId: null }, 'principals')).toEqual(['systemId is required']);
  });

  it('passes when systemId is present', () => {
    expect(validateSystemId({ systemId: 1 }, 'principals')).toEqual([]);
  });
});

// ── validateRecordsArray ─────────────────────────────────────────────────────

describe('validateRecordsArray', () => {
  it('rejects a present non-array records field and short-circuits', () => {
    expect(validateRecordsArray({ records: 'nope' })).toEqual(['records must be an array']);
  });

  it('treats null/undefined records as empty (PowerShell @() → null)', () => {
    expect(validateRecordsArray({ records: null })).toEqual(['records array cannot be empty']);
    expect(validateRecordsArray({})).toEqual(['records array cannot be empty']);
  });

  it('rejects an empty records array with no deletedIds', () => {
    expect(validateRecordsArray({ records: [] })).toEqual(['records array cannot be empty']);
  });

  it('allows empty records when deletedIds are supplied (delta-only deletes)', () => {
    expect(validateRecordsArray({ records: [], deletedIds: ['x'] })).toEqual([]);
    expect(validateRecordsArray({ deletedIds: ['x'] })).toEqual([]);
  });

  it('accepts a normal non-empty records array', () => {
    expect(validateRecordsArray({ records: [{}] })).toEqual([]);
  });

  it('rejects a records array over 50,000 items', () => {
    const big = { records: new Array(50001).fill({}) };
    expect(validateRecordsArray(big)).toEqual(['records array cannot exceed 50,000 items']);
  });
});

// ── validateDeletedIdsArray ──────────────────────────────────────────────────

describe('validateDeletedIdsArray', () => {
  it('passes when deletedIds is absent', () => {
    expect(validateDeletedIdsArray({})).toEqual([]);
  });

  it('rejects a non-array deletedIds', () => {
    expect(validateDeletedIdsArray({ deletedIds: 'x' }))
      .toEqual(['deletedIds must be an array when provided']);
  });

  it('rejects a deletedIds array over 50,000 items', () => {
    expect(validateDeletedIdsArray({ deletedIds: new Array(50001).fill('x') }))
      .toEqual(['deletedIds array cannot exceed 50,000 items']);
  });

  it('accepts a reasonable deletedIds array', () => {
    expect(validateDeletedIdsArray({ deletedIds: ['a', 'b'] })).toEqual([]);
  });
});

// ── validateEnvelopeOptions ──────────────────────────────────────────────────

describe('validateEnvelopeOptions', () => {
  it('accepts valid syncMode / idGeneration combos', () => {
    expect(validateEnvelopeOptions({ syncMode: 'full', idGeneration: 'native' })).toEqual([]);
    expect(validateEnvelopeOptions({ idGeneration: 'deterministic', idPrefix: 'sys1' })).toEqual([]);
    expect(validateEnvelopeOptions({})).toEqual([]);
  });

  it('rejects an invalid syncMode', () => {
    expect(validateEnvelopeOptions({ syncMode: 'partial' }))
      .toContain('syncMode must be "full" or "delta"');
  });

  it('rejects an invalid idGeneration', () => {
    expect(validateEnvelopeOptions({ idGeneration: 'random' }))
      .toContain('idGeneration must be "native" or "deterministic"');
  });

  it('requires idPrefix when idGeneration is deterministic', () => {
    expect(validateEnvelopeOptions({ idGeneration: 'deterministic' }))
      .toContain('idPrefix is required when idGeneration is "deterministic"');
  });
});

// ── validateRequiredFields ───────────────────────────────────────────────────

describe('validateRequiredFields', () => {
  const schema = { required: ['displayName'] };

  it('skips all required checks in delta mode', () => {
    expect(validateRequiredFields({}, 0, schema, 'delta')).toEqual([]);
  });

  it('flags a missing required field', () => {
    expect(validateRequiredFields({}, 3, schema, 'full'))
      .toEqual([`Record 3: missing required field 'displayName'`]);
  });

  it('passes when the field is present', () => {
    expect(validateRequiredFields({ displayName: 'x' }, 0, schema, 'full')).toEqual([]);
  });
});

// ── validateRequiredOneOf ────────────────────────────────────────────────────

describe('validateRequiredOneOf', () => {
  const schema = { requiredOneOf: [{ fields: ['a', 'aExt'] }] };

  it('returns no errors when the schema has no requiredOneOf', () => {
    expect(validateRequiredOneOf({}, 0, {})).toEqual([]);
  });

  it('passes when at least one field of the group is present', () => {
    expect(validateRequiredOneOf({ aExt: 'x' }, 0, schema)).toEqual([]);
  });

  it('flags a group with none of its fields present', () => {
    expect(validateRequiredOneOf({}, 2, schema))
      .toEqual([`Record 2: one of [a, aExt] is required`]);
  });
});

// ── validateAssignmentXor ────────────────────────────────────────────────────

describe('validateAssignmentXor', () => {
  it('is inert for non resource-assignments entities', () => {
    expect(validateAssignmentXor({ identityId: UUID }, 0, 'resource-assignments-identity')).toEqual([]);
  });

  it('rejects an identityId on the principal endpoint', () => {
    const out = validateAssignmentXor({ identityId: UUID }, 1, 'resource-assignments');
    expect(out[0]).toMatch(/resource-assignments-identity/);
  });

  it('rejects an identityExternalId on the principal endpoint', () => {
    const out = validateAssignmentXor({ identityExternalId: 'alice' }, 0, 'resource-assignments');
    expect(out[0]).toMatch(/resource-assignments-identity/);
  });

  it('passes a clean principal-only record', () => {
    expect(validateAssignmentXor({ principalId: UUID }, 0, 'resource-assignments')).toEqual([]);
  });
});

// ── validateIdField ──────────────────────────────────────────────────────────

describe('validateIdField', () => {
  const schema = { idField: 'id' };

  it('skips when the schema has no idField', () => {
    expect(validateIdField({ id: 'not-a-uuid' }, 0, {}, 'native')).toEqual([]);
  });

  it('skips when idGeneration is deterministic', () => {
    expect(validateIdField({ id: 'EMP-1' }, 0, schema, 'deterministic')).toEqual([]);
  });

  it('flags a malformed id UUID', () => {
    const out = validateIdField({ id: 'nope' }, 4, schema, 'native');
    expect(out[0]).toMatch(/Record 4: 'id' must be a valid UUID/);
  });

  it('passes a valid id UUID and a missing id', () => {
    expect(validateIdField({ id: UUID }, 0, schema, 'native')).toEqual([]);
    expect(validateIdField({}, 0, schema, 'native')).toEqual([]);
  });
});

// ── validateFieldValue ───────────────────────────────────────────────────────

describe('validateFieldValue', () => {
  it('flags a non-string where a string is expected', () => {
    const out = validateFieldValue('name', { type: 'string' }, 5, 0, {}, 'native');
    expect(out).toEqual([`Record 0: 'name' must be a string`]);
  });

  it('flags a bad uuid value', () => {
    const out = validateFieldValue('managerId', { type: 'uuid' }, 'nope', 0, {}, 'native');
    expect(out).toEqual([`Record 0: 'managerId' must be a valid UUID`]);
  });

  it('does not flag a bad uuid for the deterministic id field', () => {
    const out = validateFieldValue('id', { type: 'uuid' }, 'EMP-1', 0, { idField: 'id' }, 'deterministic');
    expect(out).toEqual([]);
  });

  it('flags a non-number where a number is expected', () => {
    const out = validateFieldValue('count', { type: 'number' }, 'x', 0, {}, 'native');
    expect(out).toEqual([`Record 0: 'count' must be a number`]);
  });

  it('flags a string over its maxLength', () => {
    const out = validateFieldValue('name', { type: 'string', maxLength: 3 }, 'abcd', 0, {}, 'native');
    expect(out).toEqual([`Record 0: 'name' exceeds max length of 3`]);
  });

  it('flags a value outside the enum', () => {
    const out = validateFieldValue('kind', { type: 'string', enum: ['A', 'B'] }, 'C', 0, {}, 'native');
    expect(out).toEqual([`Record 0: 'kind' must be one of: A, B`]);
  });

  it('passes a valid value', () => {
    expect(validateFieldValue('name', { type: 'string', maxLength: 10 }, 'ok', 0, {}, 'native')).toEqual([]);
  });
});

// ── validateFieldConstraints ─────────────────────────────────────────────────

describe('validateFieldConstraints', () => {
  const schema = { fields: { name: { type: 'string' }, count: { type: 'number' } } };

  it('skips undefined / null field values', () => {
    expect(validateFieldConstraints({ name: undefined, count: null }, 0, schema, 'native')).toEqual([]);
  });

  it('collects errors across multiple fields', () => {
    const out = validateFieldConstraints({ name: 1, count: 'x' }, 0, schema, 'native');
    expect(out).toHaveLength(2);
  });
});

// ── validateRecord ───────────────────────────────────────────────────────────

describe('validateRecord', () => {
  const schema = {
    required: ['displayName'],
    idField: 'id',
    fields: { id: { type: 'uuid' }, displayName: { type: 'string', maxLength: 5 } },
  };

  it('preserves the original per-record check order', () => {
    // Missing required field + over-length displayName both reported.
    const out = validateRecord({ displayName: '' }, 0, schema, 'principals', 'native', 'full');
    expect(out[0]).toMatch(/missing required field 'displayName'/);
  });

  it('returns no errors for a clean record', () => {
    const out = validateRecord({ id: UUID, displayName: 'ok' }, 0, schema, 'principals', 'native', 'full');
    expect(out).toEqual([]);
  });
});
