// The "+ Proposed roles" picker's read: the list across units. The SQL runs
// against PostgreSQL in contract-tests/workbenchInvestigations.contract.test.js.
import { describe, it, expect, vi } from 'vitest';
import { listAllInvestigations, LIST_ALL_SQL } from './proposedMatrix.js';

describe('listAllInvestigations', () => {
  it('reads every investigation with proposed roles, with its unit', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ id: 'i1' }] })) };
    expect(await listAllInvestigations(db)).toEqual([{ id: 'i1' }]);
    expect(db.query).toHaveBeenCalledWith(LIST_ALL_SQL);
    expect(LIST_ALL_SQL).toMatch(/WHERE EXISTS \(SELECT 1 FROM "RoleProposals"/);
  });
});
