// What a principal owns: which owner references name the principal, and what the
// one statement is asked. The db mock dispatches on a SQL fragment, because the
// reference resolution (lib/resourceOwners.js, not mocked — the two directions
// must share it) runs before the owned-resources read. Whether the SQL selects
// the right rows is proven on a real schema in
// contract-tests/resourceOwnership.contract.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { countOwnedResources, fetchOwnedResources, ownReferences, OWNED_LIST_LIMIT } from './ownedResources.js';

const REFERENCE_SQL = 'unnest($1::text[])';
const OWNED_SQL = `"extendedAttributes"->>'ownerId' = ANY($2::text[])`;

function stage({ references = [], owned = [] } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes(REFERENCE_SQL)) return { rows: references };
    if (sql.includes(OWNED_SQL)) return { rows: owned };
    throw new Error(`unstaged query: ${sql.slice(0, 80)}`);
  });
}

const ownedCall = () => query.mock.calls.find(([sql]) => sql.includes(OWNED_SQL));
const ME = { id: 'p-me', externalId: ' spt-17 ', employeeId: 'E-9' };

beforeEach(() => { query.mockReset(); });

describe('ownReferences', () => {
  it('keeps only the references that resolve to this very principal', async () => {
    stage({ references: [
      { ref: 'spt-17', id: 'p-me', displayName: 'Me' },
      // The employee number resolves to somebody else's account: not mine.
      { ref: 'E-9', id: 'p-other', displayName: 'Other' },
    ] });
    expect(await ownReferences(ME)).toEqual(['spt-17']);
    // Both candidates asked in one statement, trimmed.
    expect(query.mock.calls[0][1]).toEqual([['spt-17', 'E-9']]);
  });

  it('drops a reference nobody resolves, and asks once when both values are the same', async () => {
    stage({ references: [] });
    expect(await ownReferences({ id: 'p-me', externalId: 'same', employeeId: 'same' })).toEqual([]);
    expect(query.mock.calls[0][1]).toEqual([['same']]);
  });

  it('asks nothing for a principal with neither value', async () => {
    stage();
    expect(await ownReferences({ id: 'p-me', externalId: null, employeeId: '  ' })).toEqual([]);
    expect(await ownReferences({ id: 'p-me', employeeId: 4410 })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('countOwnedResources', () => {
  it('counts over both routes with the principal and its own references', async () => {
    stage({ references: [{ ref: 'spt-17', id: 'p-me' }, { ref: 'E-9', id: 'p-me' }], owned: [{ cnt: 12 }] });
    expect(await countOwnedResources(ME)).toBe(12);
    const [sql, params] = ownedCall();
    expect(sql).toMatch(/^SELECT count\(\*\)::int AS cnt FROM \(/);
    expect(params).toEqual(['p-me', ['spt-17', 'E-9']]);
  });

  it('is zero when the statement returns no row', async () => {
    stage({ owned: [] });
    expect(await countOwnedResources({ id: 'p-me' })).toBe(0);
    // No reference names the principal: the reference route matches nothing.
    expect(ownedCall()[1]).toEqual(['p-me', []]);
  });
});

describe('fetchOwnedResources', () => {
  it('returns the rows by name, capped', async () => {
    const owned = [{ resourceId: 'r1', displayName: 'A', resourceType: 'Entitlement', via: 'link' }];
    stage({ owned });
    expect(await fetchOwnedResources({ id: 'p-me' })).toEqual(owned);
    const [sql] = ownedCall();
    expect(sql).toMatch(/ORDER BY "displayName", "resourceId"\s+LIMIT 1000\s*$/);
    expect(OWNED_LIST_LIMIT).toBe(1000);
  });

  it('follows the ownership link from the owner to the live owned resource', async () => {
    stage();
    await fetchOwnedResources({ id: 'p-me' });
    const [sql] = ownedCall();
    const link = sql.split('UNION')[0];
    expect(link).toContain(`ra."principalId" = $1`);
    expect(link).toContain(`ra."assignmentType" = 'Direct'`);
    expect(link).toContain(`ra."deletedAt" IS NULL`);
    expect(link).toContain(`p."deletedAt" IS NULL`);
    expect(link).toMatch(/o\."resourceType" IN \('GroupOwnership','ServicePrincipalOwnership','ApplicationOwnership','ResourceOwnership'\)/);
    expect(link).toContain(`o."deletedAt" IS NULL`);
    expect(link).toMatch(/rr\."childResourceId" = o\.id\s+AND rr\."relationshipType" IN \('HasOwnership','HasAppOwnership'\)/);
    expect(link).toMatch(/r\.id = rr\."parentResourceId" AND r\."deletedAt" IS NULL/);
  });

  it('adds a referenced resource only when no ownership link answers for it', async () => {
    stage();
    await fetchOwnedResources({ id: 'p-me' });
    const reference = ownedCall()[0].split('UNION')[1];
    expect(reference).toContain(`r."deletedAt" IS NULL`);
    expect(reference).toMatch(/AND NOT EXISTS \(SELECT 1[\s\S]*lrr\."parentResourceId" = r\.id\)/);
  });
});
