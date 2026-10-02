// Unit tests for the stored context assignment counts.
//
// The db mock is SQL-blind, so what these can pin is the shape of the statement
// — the decisions that are easy to undo by accident — and the function's own
// contract. Whether the statement returns the right numbers is proven against
// real PostgreSQL in contract-tests/contextAssignmentCounts.contract.test.js.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { COUNT_COLUMNS, REFRESH_SQL, refreshContextAssignmentCounts } from './assignmentCounts.js';
import { OWNERSHIP_TYPES_SQL } from '../lib/ownershipTypes.js';

describe('refreshContextAssignmentCounts — the statement', () => {
  it('de-duplicates holders per resource before counting, so a governed twin row is one holder', () => {
    expect(REFRESH_SQL).toMatch(/SELECT DISTINCT ra\."resourceId" AS rid,\s+COALESCE\(ra\."principalId", ra\."identityId"\) AS h,\s+ra\."assignmentType" AS t/);
  });

  it('never counts a soft-deleted assignment, in either pass', () => {
    expect(REFRESH_SQL.match(/ra\."deletedAt" IS NULL/g)).toHaveLength(2);
  });

  it('counts only live resources, and never the synthetic ownership rows', () => {
    expect(REFRESH_SQL).toContain('r."deletedAt" IS NULL');
    expect(REFRESH_SQL).toContain(`r."resourceType" NOT IN ${OWNERSHIP_TYPES_SQL}`);
    expect(REFRESH_SQL).toContain(`cm."memberType" = 'Resource'`);
  });

  it('counts distinct holders over what is held now, not what could be activated', () => {
    expect(REFRESH_SQL).toMatch(/SELECT DISTINCT m\.cid, COALESCE\(ra\."principalId", ra\."identityId"\) AS h/);
    expect(REFRESH_SQL).toContain(`ra."assignmentType" IN ('Direct', 'Indirect')`);
  });

  it('touches only contexts that group resources', () => {
    expect(REFRESH_SQL).toContain(`WHERE c."targetType" = 'Resource'`);
  });

  it('writes a row only when one of its five numbers changed', () => {
    expect(COUNT_COLUMNS).toHaveLength(5);
    for (const column of COUNT_COLUMNS) {
      expect(REFRESH_SQL, column).toContain(`"${column}" = n."${column}"`);
      expect(REFRESH_SQL, column).toContain(`c."${column}" IS DISTINCT FROM n."${column}"`);
    }
    // One OR-chain: an AND would skip a context where only one number moved.
    expect(REFRESH_SQL.match(/ IS DISTINCT FROM /g)).toHaveLength(5);
    expect(REFRESH_SQL.match(/" OR c\."/g)).toHaveLength(4);
  });
});

describe('refreshContextAssignmentCounts — the call', () => {
  it('runs the statement once and reports how many contexts changed', async () => {
    query.mockReset();
    query.mockResolvedValue({ rowCount: 7 });
    const result = await refreshContextAssignmentCounts();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(REFRESH_SQL);
    expect(result.updated).toBe(7);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reads the embedded database\'s row count too, and reports 0 when there is none', async () => {
    const embedded = { query: vi.fn().mockResolvedValue({ affectedRows: 3 }) };
    expect((await refreshContextAssignmentCounts(embedded)).updated).toBe(3);
    const silent = { query: vi.fn().mockResolvedValue({}) };
    expect((await refreshContextAssignmentCounts(silent)).updated).toBe(0);
  });

  it('uses the client it is given instead of the shared pool', async () => {
    query.mockReset();
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    await refreshContextAssignmentCounts(client);
    expect(client.query).toHaveBeenCalledWith(REFRESH_SQL);
    expect(query).not.toHaveBeenCalled();
  });

  it('lets a failure through: the caller decides it is non-fatal', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('canceling statement')) };
    await expect(refreshContextAssignmentCounts(client)).rejects.toThrow('canceling statement');
  });
});
