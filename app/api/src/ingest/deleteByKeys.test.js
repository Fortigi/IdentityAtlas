import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');   // the shared manual mock (src/db/__mocks__/connection.js)

import * as db from '../db/connection.js';
import {
  validateDeletedKeys, buildDeleteByKeysSql, applyDeleteByKeys, DELETE_BY_KEY_ENTITIES, MAX_DELETED_KEYS,
} from './deleteByKeys.js';
import { validateRecordsArray } from './validation.helpers.js';

const R1 = '11111111-1111-1111-1111-111111111111';
const R2 = '22222222-2222-2222-2222-222222222222';
const P1 = '33333333-3333-3333-3333-333333333333';
const P2 = '44444444-4444-4444-4444-444444444444';
const RA = DELETE_BY_KEY_ENTITIES['resource-assignments'];

beforeEach(() => { db.query.mockReset(); });

describe('validateDeletedKeys', () => {
  it('accepts a body without deletedKeys, and an empty list', () => {
    expect(validateDeletedKeys({}, 'resource-assignments')).toEqual([]);
    expect(validateDeletedKeys({ deletedKeys: null }, 'resource-assignments')).toEqual([]);
    expect(validateDeletedKeys({ deletedKeys: [] }, 'principals')).toEqual([]);
  });

  it('accepts a complete key, with governed omitted', () => {
    const body = { deletedKeys: [{ resourceId: R1, principalId: P1, assignmentType: 'Direct' }] };
    expect(validateDeletedKeys(body, 'resource-assignments')).toEqual([]);
  });

  it('refuses deletedKeys on an entity that has no key spec', () => {
    const body = { deletedKeys: [{ id: R1 }] };
    expect(validateDeletedKeys(body, 'principals')).toEqual(['deletedKeys is not supported for principals']);
  });

  it('refuses a non-array', () => {
    expect(validateDeletedKeys({ deletedKeys: { resourceId: R1 } }, 'resource-assignments'))
      .toEqual(['deletedKeys must be an array when provided']);
  });

  it('names the first bad entry and why', () => {
    const ok = { resourceId: R1, principalId: P1, assignmentType: 'Direct' };
    expect(validateDeletedKeys({ deletedKeys: [ok, { resourceId: R1, assignmentType: 'Direct' }] }, 'resource-assignments'))
      .toEqual(['deletedKeys[1]: principalId is required']);
    expect(validateDeletedKeys({ deletedKeys: [{ ...ok, resourceId: 'grp-1' }] }, 'resource-assignments'))
      .toEqual(['deletedKeys[0]: resourceId must be a UUID']);
    expect(validateDeletedKeys({ deletedKeys: [{ ...ok, governed: 'false' }] }, 'resource-assignments'))
      .toEqual(['deletedKeys[0]: governed must be a boolean']);
    expect(validateDeletedKeys({ deletedKeys: [{ ...ok, assignmentType: 3 }] }, 'resource-assignments'))
      .toEqual(['deletedKeys[0]: assignmentType must be a string']);
    expect(validateDeletedKeys({ deletedKeys: ['x'] }, 'resource-assignments'))
      .toEqual(['deletedKeys[0]: must be an object']);
  });

  it('caps the batch size', () => {
    const key = { resourceId: R1, principalId: P1, assignmentType: 'Direct' };
    expect(validateDeletedKeys({ deletedKeys: Array(MAX_DELETED_KEYS).fill(key) }, 'resource-assignments')).toEqual([]);
    expect(validateDeletedKeys({ deletedKeys: Array(MAX_DELETED_KEYS + 1).fill(key) }, 'resource-assignments'))
      .toEqual(['deletedKeys array cannot exceed 50,000 items']);
  });
});

describe('validateRecordsArray with deletedKeys', () => {
  it('accepts a delta batch that only carries deletedKeys', () => {
    expect(validateRecordsArray({ syncMode: 'delta', records: [], deletedKeys: [{}] })).toEqual([]);
  });

  it('still refuses a delta batch with nothing at all', () => {
    expect(validateRecordsArray({ syncMode: 'delta', records: [], deletedKeys: [] }))
      .toEqual(['records array cannot be empty']);
  });
});

describe('buildDeleteByKeysSql', () => {
  const keys = [
    { resourceId: R1, principalId: P1, assignmentType: 'Direct' },
    { resourceId: R2, principalId: P2, assignmentType: 'Indirect', governed: true },
  ];

  it('soft-deletes assignments by unnesting one array per key column, column-aligned', () => {
    const { sql, params } = buildDeleteByKeysSql(RA, keys, 9);
    expect(sql).toBe(
      'UPDATE "ResourceAssignments" t SET "deletedAt" = now() '
      + 'FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::boolean[]) AS k("resourceId", "principalId", "assignmentType", "governed") '
      + 'WHERE t."resourceId" = k."resourceId" AND t."principalId" = k."principalId" '
      + 'AND t."assignmentType" = k."assignmentType" AND t."governed" = k."governed" '
      + 'AND t."systemId" = $5 AND t."principalId" IS NOT NULL AND t."deletedAt" IS NULL',
    );
    // governed omitted on the first key → its default (false), not undefined.
    expect(params).toEqual([[R1, R2], [P1, P2], ['Direct', 'Indirect'], [false, true], 9]);
  });

  it('adds the ownership predicate for a key restricted to specific systems', () => {
    const { sql, params } = buildDeleteByKeysSql(RA, keys.slice(0, 1), 9, [9, 12]);
    expect(sql).toContain('AND COALESCE((t."systemId" = ANY($6::int[])), false) AND t."deletedAt" IS NULL');
    expect(params.at(-1)).toEqual([9, 12]);
  });

  it('hard-deletes on a table that is not soft-delete', () => {
    const spec = { table: 'ResourceRelationships', columns: [{ name: 'parentResourceId', type: 'uuid' }] };
    const { sql } = buildDeleteByKeysSql(spec, [{ parentResourceId: R1 }], 3);
    expect(sql).toBe(
      'DELETE FROM "ResourceRelationships" t USING unnest($1::uuid[]) AS k("parentResourceId") '
      + 'WHERE t."parentResourceId" = k."parentResourceId" AND t."systemId" = $2',
    );
  });
});

describe('applyDeleteByKeys', () => {
  it('is a no-op without deletedKeys', async () => {
    const result = { deleted: 2 };
    expect(await applyDeleteByKeys({ systemId: 1 }, 'resource-assignments', result)).toBe(null);
    expect(db.query).not.toHaveBeenCalled();
    expect(result.deleted).toBe(2);
  });

  it('runs one statement for the batch and adds its row count', async () => {
    db.query.mockResolvedValue({ rowCount: 2 });
    const result = { deleted: 1 };
    const body = { systemId: 4, deletedKeys: [
      { resourceId: R1, principalId: P1, assignmentType: 'Direct' },
      { resourceId: R2, principalId: P2, assignmentType: 'Direct' },
    ] };
    expect(await applyDeleteByKeys(body, 'resource-assignments', result)).toBe(null);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1].at(-1)).toBe(4);
    expect(result.deleted).toBe(3);
  });

  it('answers 400 for an entity without a key spec', async () => {
    const r = await applyDeleteByKeys({ systemId: 1, deletedKeys: [{ id: R1 }] }, 'principals', { deleted: 0 });
    expect(r.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('answers 500 and leaves the count alone when the delete fails', async () => {
    db.query.mockRejectedValue(new Error('boom'));
    const result = { deleted: 0 };
    const body = { systemId: 1, deletedKeys: [{ resourceId: R1, principalId: P1, assignmentType: 'Direct' }] };
    const r = await applyDeleteByKeys(body, 'resource-assignments', result);
    expect(r).toEqual({ status: 500, body: { error: 'Delete-by-key failed', message: 'boom' } });
    expect(result.deleted).toBe(0);
  });
});
