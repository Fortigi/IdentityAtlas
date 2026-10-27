// Unit tests for the decisions in contextOwners.js around its one statement:
// which loads run it, which contexts it is scoped to, and how its row becomes the
// counts. What the SQL selects (tie-breaks, the ambiguous employee number, the
// analyst's Accountable surviving) is only meaningful against PostgreSQL and is
// verified in contract-tests/contextOwnerRoles.contract.test.js.

import { describe, it, expect, vi } from 'vitest';
import {
  reconcileBatchAccountables, reconcileSessionAccountables, buildAccountableReconcileSql,
  ownerResolutionCtes, OWNER_PRINCIPAL_ORDER, OWNER_ADDED_BY,
} from './contextOwners.js';

const ID1 = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';
const runner = (row) => ({ query: vi.fn().mockResolvedValue({ rows: row === undefined ? [] : [row] }) });
const COUNTS = { set: 3, replaced: 1, removed: 2, unresolved: 5 };

describe('reconcileBatchAccountables', () => {
  it('runs once for a contexts batch, scoped to the batch ids, and returns the four counts', async () => {
    const r = runner(COUNTS);
    await expect(reconcileBatchAccountables(r, 'Contexts', [{ id: ID1 }, { id: ID2 }])).resolves.toEqual(COUNTS);
    expect(r.query).toHaveBeenCalledTimes(1);
    const [sql, params] = r.query.mock.calls[0];
    expect(sql).toContain('(c.id = ANY($1::uuid[]))');
    expect(params).toEqual([[ID1, ID2]]);
  });

  it('skips records without an id rather than sending a null into the uuid array', async () => {
    const r = runner(COUNTS);
    await reconcileBatchAccountables(r, 'Contexts', [{ id: ID1 }, {}, null, { id: '' }]);
    expect(r.query.mock.calls[0][1]).toEqual([[ID1]]);
  });

  it.each(['Principals', 'Resources', 'contexts', 'ContextMembers'])('never queries for table %s', async (table) => {
    const r = runner(COUNTS);
    await expect(reconcileBatchAccountables(r, table, [{ id: ID1 }])).resolves.toBeNull();
    expect(r.query).not.toHaveBeenCalled();
  });

  it('never queries for an empty batch or one with no ids', async () => {
    for (const records of [[], [{}], undefined]) {
      const r = runner(COUNTS);
      await expect(reconcileBatchAccountables(r, 'Contexts', records)).resolves.toBeNull();
      expect(r.query).not.toHaveBeenCalled();
    }
  });

  it('reads a missing count as zero', async () => {
    await expect(reconcileBatchAccountables(runner({ set: 2 }), 'Contexts', [{ id: ID1 }]))
      .resolves.toEqual({ set: 2, replaced: 0, removed: 0, unresolved: 0 });
    await expect(reconcileBatchAccountables(runner(), 'Contexts', [{ id: ID1 }]))
      .resolves.toEqual({ set: 0, replaced: 0, removed: 0, unresolved: 0 });
  });
});

describe('reconcileSessionAccountables', () => {
  it('scopes to the session temp table, with no parameters', async () => {
    const r = runner(COUNTS);
    await expect(reconcileSessionAccountables(r, 'Contexts', '_tmp_session_abc')).resolves.toEqual(COUNTS);
    const [sql, params] = r.query.mock.calls[0];
    expect(sql).toContain('(c.id IN (SELECT "id" FROM "_tmp_session_abc"))');
    expect(params).toEqual([]);
  });

  it('is a no-op for another table or without a temp table', async () => {
    for (const [table, temp] of [['Principals', '_tmp_x'], ['Contexts', ''], ['Contexts', undefined]]) {
      const r = runner(COUNTS);
      await expect(reconcileSessionAccountables(r, table, temp)).resolves.toBeNull();
      expect(r.query).not.toHaveBeenCalled();
    }
  });
});

describe('the statement', () => {
  const sql = buildAccountableReconcileSql('TRUE');
  const ctes = ownerResolutionCtes('TRUE');

  it('considers synced contexts only, and an owner only on a role-bearing template', () => {
    expect(ctes).toMatch(/WHERE c\.variant = 'synced' AND \(TRUE\)/);
    expect(ctes).toMatch(/CASE WHEN c\."contextCategory" IN \('OrganizationalUnit', 'LogicalApplication'\) THEN NULLIF\(c\."ownerUserId", ''\) END AS owner/);
  });

  it('resolves by externalId with the read endpoints\' tie-break, then by a unique live employeeId', () => {
    expect(ctes).toContain(`ORDER BY c.id, ${OWNER_PRINCIPAL_ORDER}`);
    expect(OWNER_PRINCIPAL_ORDER).toMatch(/^\(p\."deletedAt" IS NULL\) DESC,\s+\(p\."systemId" IS NOT DISTINCT FROM c\."scopeSystemId"\) DESC,\s+p\.id$/);
    expect(ctes).toMatch(/JOIN "Principals" p ON p\."employeeId" = c\.owner AND p\."deletedAt" IS NULL/);
    expect(ctes).toMatch(/HAVING count\(\*\) = 1/);
    expect(ctes).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM by_external_id x WHERE x\."contextId" = c\.id\)/);
  });

  it('marks its own rows with an addedBy no crawler, plugin or analyst writes', () => {
    expect(OWNER_ADDED_BY).toBe('sourceOwner');
  });

  it('only ever replaces or removes an Accountable it added itself — never a crawler\'s sync one', () => {
    const replaced = sql.slice(sql.indexOf('replaced AS'), sql.indexOf('removed AS'));
    const removed = sql.slice(sql.indexOf('removed AS'), sql.indexOf('added AS'));
    expect(replaced).toContain(`a."addedBy" = 'sourceOwner'`);
    expect(removed).toContain(`a."addedBy" = 'sourceOwner'`);
    expect(sql).not.toContain(`'sync'`);
    expect(sql).toMatch(/WHERE r\.role = 'Accountable'/);
  });

  it('adds only where no Accountable exists, as addedBy sourceOwner, yielding to a concurrent one', () => {
    const added = sql.slice(sql.indexOf('added AS'));
    expect(added).toMatch(/SELECT res\."contextId", res\."principalId", 'Accountable', 'sourceOwner'/);
    expect(added).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM accountable a WHERE a\."contextId" = res\."contextId"\)/);
    expect(added).toContain('ON CONFLICT DO NOTHING');
  });
});
