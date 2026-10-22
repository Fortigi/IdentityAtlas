// Holders and owner per resource member of a context page. The db mock is
// SQL-blind, so reads are recognised by a fragment of each statement (they run
// in one Promise.all). The owner resolution itself is lib/resourceOwners.js's,
// tested there; here it matters that the page uses it and asks once per page.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { withResourceMemberFacts } from './resourceMemberFacts.js';

const HOLDERS_SQL = 'AS "holderCount"';
const LINKED_SQL = '"parentResourceId" = ANY';
const REFERENCE_SQL = 'unnest($1::text[])';

function stage({ holders = [], linked = [], references = [] } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes(HOLDERS_SQL)) return { rows: holders };
    if (sql.includes(LINKED_SQL)) return { rows: linked };
    if (sql.includes(REFERENCE_SQL)) return { rows: references };
    throw new Error(`unstaged query: ${sql.slice(0, 80)}`);
  });
}

const member = (id, extendedAttributes = {}) => ({
  id, displayName: `ENT_${id}`, resourceType: 'Entitlement', description: null, enabled: true, extendedAttributes,
});

beforeEach(() => { query.mockReset(); });

describe('withResourceMemberFacts', () => {
  it('adds the holder count and the owner, and drops the attributes it read the owner from', async () => {
    stage({
      holders: [{ id: 'a', holderCount: 45000 }, { id: 'b', holderCount: 3 }],
      linked: [{ id: 'a', ownerId: 'p1', ownerName: 'Link Owner', ownerEmail: 'l@x', ownerEmployeeId: 'E-1' }],
      references: [{ ref: 'spt-17', id: 'p9', displayName: 'Grace Hopper', email: 'g@x', employeeId: 'E-9' }],
    });
    const rows = await withResourceMemberFacts([
      member('a'), member('b', { ownerId: 'spt-17' }), member('c', { requestable: true }),
    ]);
    expect(rows).toEqual([
      { id: 'a', displayName: 'ENT_a', resourceType: 'Entitlement', description: null, enabled: true,
        holderCount: 45000, ownerDisplayName: 'Link Owner', ownerEmployeeId: 'E-1', ownerEmail: 'l@x' },
      { id: 'b', displayName: 'ENT_b', resourceType: 'Entitlement', description: null, enabled: true,
        holderCount: 3, ownerDisplayName: 'Grace Hopper', ownerEmployeeId: 'E-9', ownerEmail: 'g@x' },
      // Nobody holds it: 0, not blank — and nobody owns it.
      { id: 'c', displayName: 'ENT_c', resourceType: 'Entitlement', description: null, enabled: true,
        holderCount: 0, ownerDisplayName: null, ownerEmployeeId: null, ownerEmail: null },
    ]);
  });

  it('counts the page in one grouped read over its id array, live assignments only', async () => {
    stage();
    const page = Array.from({ length: 200 }, (_, i) => member(`r${i}`, { ownerId: `o${i % 4}` }));
    await withResourceMemberFacts(page);
    // holders + owner links + owner references: three reads for 200 rows.
    expect(query).toHaveBeenCalledTimes(3);
    const [sql, params] = query.mock.calls.find(([s]) => s.includes(HOLDERS_SQL));
    expect(params).toEqual([page.map(r => r.id)]);
    expect(sql).toContain('ra."resourceId" = ANY($1::uuid[])');
    expect(sql).toContain('ra."deletedAt" IS NULL');
    expect(sql).toMatch(/SELECT DISTINCT ra\."resourceId" AS id, COALESCE\(ra\."principalId", ra\."identityId"\) AS h/);
    expect(sql).toContain('GROUP BY d.id');
  });

  it('reads nothing for an empty page', async () => {
    expect(await withResourceMemberFacts([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
