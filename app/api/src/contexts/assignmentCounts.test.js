// Unit tests for the stored context assignment counts.
//
// The db mock is SQL-blind, so what these can pin is the shape of the three
// statements — the decisions that are easy to undo by accident — and the
// function's own contract. Whether they return the right numbers is proven
// against real PostgreSQL in contract-tests/contextAssignmentCounts.contract.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query, tx } from '../db/connection.js';
import {
  ASSIGNMENTS_SQL, COUNT_COLUMNS, HOLDERS_SQL, UPDATE_SQL, refreshContextAssignmentCounts,
} from './assignmentCounts.js';
import { OWNERSHIP_TYPES_SQL } from '../lib/ownershipTypes.js';

describe('refreshContextAssignmentCounts — the statements', () => {
  it('de-duplicates holders per resource before counting, so a governed twin row is one holder', () => {
    expect(ASSIGNMENTS_SQL).toMatch(/SELECT DISTINCT ra\."resourceId" AS rid,\s+COALESCE\(ra\."principalId", ra\."identityId"\) AS h,\s+ra\."assignmentType" AS t/);
  });

  it('never counts a soft-deleted assignment, in either pass', () => {
    expect(ASSIGNMENTS_SQL).toContain('ra."deletedAt" IS NULL');
    expect(HOLDERS_SQL).toContain('ra."deletedAt" IS NULL');
  });

  it.each([['assignments', ASSIGNMENTS_SQL], ['holders', HOLDERS_SQL]])(
    'counts only live resources, and never the synthetic ownership rows (%s)', (_name, sql) => {
      expect(sql).toContain('r."deletedAt" IS NULL');
      expect(sql).toContain(`r."resourceType" NOT IN ${OWNERSHIP_TYPES_SQL}`);
      expect(sql).toContain(`cm."memberType" = 'Resource'`);
    });

  it('counts distinct holders over what is held now, not what could be activated', () => {
    expect(HOLDERS_SQL).toMatch(/SELECT DISTINCT cm\."contextId" AS cid, COALESCE\(ra\."principalId", ra\."identityId"\) AS h/);
    expect(HOLDERS_SQL).toContain(`ra."assignmentType" IN ('Direct', 'Indirect')`);
  });

  it('keeps a resource nobody holds as a resource: the per-resource counts are LEFT joined', () => {
    expect(ASSIGNMENTS_SQL).toMatch(/LEFT JOIN \(\s+SELECT x\.rid,/);
  });

  it('stages both passes in tables that vanish with the transaction', () => {
    expect(ASSIGNMENTS_SQL).toContain('CREATE TEMP TABLE ctx_assignment_counts ON COMMIT DROP AS');
    expect(HOLDERS_SQL).toContain('CREATE TEMP TABLE ctx_holder_counts ON COMMIT DROP AS');
  });

  it('touches only contexts that group resources, and zeroes the ones that have nothing', () => {
    expect(UPDATE_SQL).toContain(`WHERE x."targetType" = 'Resource'`);
    expect(UPDATE_SQL).toContain('LEFT JOIN ctx_assignment_counts a ON a.cid = x.id');
    expect(UPDATE_SQL).toContain('LEFT JOIN ctx_holder_counts h ON h.cid = x.id');
    expect(UPDATE_SQL.match(/COALESCE\([ah]\.\w+, 0\)/g)).toHaveLength(5);
  });

  it('writes a row only when one of its five numbers changed', () => {
    expect(COUNT_COLUMNS).toHaveLength(5);
    for (const column of COUNT_COLUMNS) {
      expect(UPDATE_SQL, column).toContain(`"${column}" = n."${column}"`);
      expect(UPDATE_SQL, column).toContain(`c."${column}" IS DISTINCT FROM n."${column}"`);
    }
    // One OR-chain: an AND would skip a context where only one number moved.
    expect(UPDATE_SQL.match(/ IS DISTINCT FROM /g)).toHaveLength(5);
    expect(UPDATE_SQL.match(/" OR c\."/g)).toHaveLength(4);
  });
});

describe('refreshContextAssignmentCounts — the call', () => {
  beforeEach(() => query.mockReset());

  it('runs the three statements in order, in one transaction, and reports the contexts changed', async () => {
    query.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ rowCount: 7 });
    tx.mockClear();

    const result = await refreshContextAssignmentCounts();

    expect(tx).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.map(c => c[0])).toEqual([ASSIGNMENTS_SQL, HOLDERS_SQL, UPDATE_SQL]);
    expect(result.updated).toBe(7);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reads the embedded database\'s row count too, and reports 0 when there is none', async () => {
    const run = (last) => refreshContextAssignmentCounts(fn => fn({
      query: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce(last),
    }));
    expect((await run({ affectedRows: 3 })).updated).toBe(3);
    expect((await run({})).updated).toBe(0);
    // The UPDATE's count, never a staging statement's.
    expect((await run({ rowCount: 0, affectedRows: 9 })).updated).toBe(0);
  });

  it('uses the transaction it is given instead of the shared pool', async () => {
    tx.mockClear();
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    await refreshContextAssignmentCounts(fn => fn(client));
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(tx).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('stops at the first failure and lets it through: the caller decides it is non-fatal', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('canceling statement')) };
    await expect(refreshContextAssignmentCounts(fn => fn(client))).rejects.toThrow('canceling statement');
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
