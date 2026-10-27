// The Proposed lens reads: the list across units, the accounts' matrix rows. The SQL
// runs against PostgreSQL in contract-tests/workbenchInvestigations.contract.test.js.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../routes/permissions/gridQuery.js', () => ({
  discoverGridColumns: vi.fn(async () => ({ dynamicUserCols: 'u."department",' })),
  shapeManagedByPackages: (rows) => rows.map(r => ({ ...r, accessPackageIds: r.accessPackageIds.split(',') })),
}));

const { listAllInvestigations, proposedMatrixRows, parsePrincipalIds, rowsSql, COVERED_SQL, LIST_ALL_SQL, MAX_PRINCIPALS } = await import('./proposedMatrix.js');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('parsePrincipalIds', () => {
  it('keeps ids, lower-cased, once', () => {
    expect(parsePrincipalIds([A.toUpperCase(), A, B])).toEqual([A, B]);
    expect(parsePrincipalIds([])).toEqual([]);
  });
  it.each([[undefined, /must be a list/], ['x', /must be a list/], [['nope'], /not an id/], [[1], /not an id/]])('refuses %j', (v, msg) => {
    expect(() => parsePrincipalIds(v)).toThrow(msg);
  });
  it('refuses more than the cap', () => {
    expect(() => parsePrincipalIds(Array.from({ length: MAX_PRINCIPALS + 1 }, () => A))).toThrow(/At most 2000/);
  });
});

describe('proposedMatrixRows', () => {
  it('reads the accounts’ rows with the matrix’s own columns, and who covers each cell', async () => {
    const db = {
      getPool: vi.fn(async () => ({})),
      query: vi.fn(async (sql) => ({ rows: sql === COVERED_SQL ? [{ memberId: A, resourceId: 'r', groupId: 'r', accessPackageIds: 'br1,br2' }] : [{ memberId: A, resourceId: 'r' }] })),
    };
    const out = await proposedMatrixRows(db, { principalIds: [A] });
    expect(out).toEqual({ data: [{ memberId: A, resourceId: 'r' }], managedByPackages: [{ memberId: A, resourceId: 'r', groupId: 'r', accessPackageIds: ['br1', 'br2'] }] });
    expect(db.query.mock.calls[0]).toEqual([rowsSql('u."department",'), [[A]]]);
    expect(rowsSql('X')).toMatch(/WHERE p\."principalId" = ANY\(\$1::uuid\[\]\)/);
  });

  it('reads nothing for no accounts', async () => {
    const db = { getPool: vi.fn(), query: vi.fn() };
    expect(await proposedMatrixRows(db, { principalIds: [] })).toEqual({ data: [], managedByPackages: [] });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('listAllInvestigations', () => {
  it('reads every investigation with proposed roles, with its unit', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ id: 'i1' }] })) };
    expect(await listAllInvestigations(db)).toEqual([{ id: 'i1' }]);
    expect(db.query).toHaveBeenCalledWith(LIST_ALL_SQL);
    expect(LIST_ALL_SQL).toMatch(/WHERE EXISTS \(SELECT 1 FROM "RoleProposals"/);
  });
});
