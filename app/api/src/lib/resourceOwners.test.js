// Who owns an entitlement: the ownership link first, the source's own owner
// reference second, the source's words last. The db mock dispatches on a SQL
// fragment per statement, because the two reads run in one Promise.all. Whether
// the SQL itself selects the right account (externalId before employeeId, a
// shared employeeId refused) is proven on a real schema in
// contract-tests/applicationAccessReview.contract.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import {
  fetchOwners, fetchResourceOwners, groupOwners, linkedOwnerExistsSql, ownerReference, referencedOwner,
} from './resourceOwners.js';

const LINKED_SQL = '"parentResourceId" = ANY';
const REFERENCE_SQL = 'unnest($1::text[])';

function stage({ linked = [], references = [] } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes(LINKED_SQL)) return { rows: linked };
    if (sql.includes(REFERENCE_SQL)) return { rows: references };
    throw new Error(`unstaged query: ${sql.slice(0, 80)}`);
  });
}

const ent = (id, extendedAttributes = {}) => ({ id, extendedAttributes });

beforeEach(() => { query.mockReset(); });

describe('groupOwners', () => {
  it('folds owner links into one entry per entitlement while keeping the people apart', () => {
    const grouped = groupOwners([
      { id: 'e1', ownerId: 'p1', ownerName: 'A', ownerEmail: 'a@x', ownerEmployeeId: 'E1' },
      { id: 'e1', ownerId: 'p2', ownerName: 'B', ownerEmail: null, ownerEmployeeId: 'E2' },
      { id: 'e2', ownerId: 'p1', ownerName: 'A', ownerEmail: 'a@x', ownerEmployeeId: null },
    ]);
    expect(grouped.get('e1')).toEqual({ ownerName: 'A, B', ownerEmail: 'a@x', ownerEmployeeId: 'E1, E2', ownerIds: ['p1', 'p2'] });
    expect(grouped.get('e2')).toEqual({ ownerName: 'A', ownerEmail: 'a@x', ownerEmployeeId: null, ownerIds: ['p1'] });
  });
});

describe('ownerReference', () => {
  it('reads ownerId and ownerName whatever their case or underscores', () => {
    expect(ownerReference(ent('a', { OWNER_ID: ' spt-17 ', ownername: 'Grace Hopper' })))
      .toEqual({ ref: 'spt-17', name: 'Grace Hopper' });
    expect(ownerReference(ent('a', { ownerId: 4410 }))).toEqual({ ref: '4410', name: null });
  });

  it('finds nothing in blanks, objects or a missing attribute bag', () => {
    expect(ownerReference(ent('a', { ownerId: '  ', ownerName: { first: 'x' } }))).toEqual({ ref: null, name: null });
    expect(ownerReference({ id: 'a' })).toEqual({ ref: null, name: null });
    expect(ownerReference(undefined)).toEqual({ ref: null, name: null });
  });
});

describe('referencedOwner', () => {
  const resolved = new Map([['spt-17', { id: 'p9', displayName: 'Grace Hopper', email: 'g@x', employeeId: 'E-9' }]]);

  it('is the account the reference resolved to', () => {
    expect(referencedOwner({ ref: 'spt-17', name: 'Stale Name' }, resolved))
      .toEqual({ ownerName: 'Grace Hopper', ownerEmail: 'g@x', ownerEmployeeId: 'E-9', ownerIds: ['p9'] });
  });

  it('falls back to the source\'s name, then its id, as-is', () => {
    expect(referencedOwner({ ref: 'spt-99', name: 'Ada Lovelace' }, resolved))
      .toEqual({ ownerName: 'Ada Lovelace', ownerEmail: null, ownerEmployeeId: null, ownerIds: ['source:spt-99'] });
    expect(referencedOwner({ ref: 'spt-99', name: null }, resolved).ownerName).toBe('spt-99');
    expect(referencedOwner({ ref: null, name: 'Only A Name' }, resolved).ownerIds).toEqual(['source:Only A Name']);
  });

  it('is nobody when the source named nobody', () => {
    expect(referencedOwner({ ref: null, name: null }, resolved)).toBeNull();
  });
});

describe('fetchOwners', () => {
  it('prefers the ownership link, falls back to the reference, and leaves an unowned one out', async () => {
    stage({
      linked: [{ id: 'linked', ownerId: 'p1', ownerName: 'Link Owner', ownerEmail: 'l@x', ownerEmployeeId: 'E-1' }],
      references: [{ ref: 'spt-17', id: 'p9', displayName: 'Grace Hopper', email: 'g@x', employeeId: 'E-9' }],
    });
    const owners = await fetchOwners([
      // Linked AND carrying a reference to someone else: the link wins.
      ent('linked', { ownerId: 'spt-17', ownerName: 'Grace Hopper' }),
      ent('byRef', { ownerId: 'spt-17' }),
      ent('unresolved', { ownerId: 'spt-404', ownerName: 'Gone Person' }),
      ent('unowned', { certfrequency: 'Annually' }),
    ]);
    expect(owners.get('linked')).toMatchObject({ ownerName: 'Link Owner', ownerEmployeeId: 'E-1', ownerIds: ['p1'] });
    expect(owners.get('byRef')).toEqual({ ownerName: 'Grace Hopper', ownerEmail: 'g@x', ownerEmployeeId: 'E-9', ownerIds: ['p9'] });
    expect(owners.get('unresolved')).toMatchObject({ ownerName: 'Gone Person', ownerEmployeeId: null, ownerEmail: null });
    expect(owners.has('unowned')).toBe(false);
  });

  it('asks two questions whatever the number of entitlements — each reference once', async () => {
    stage();
    const many = Array.from({ length: 500 }, (_, i) => ent(`e${i}`, { ownerId: `o${i % 3}` }));
    await fetchOwners([...many, many[0]]);
    expect(query).toHaveBeenCalledTimes(2);
    const linkedParams = query.mock.calls.find(([sql]) => sql.includes(LINKED_SQL))[1];
    expect(linkedParams[0]).toHaveLength(500);
    const refParams = query.mock.calls.find(([sql]) => sql.includes(REFERENCE_SQL))[1];
    expect(refParams).toEqual([['o0', 'o1', 'o2']]);
  });

  it('skips the reference read when no entitlement names an owner', async () => {
    stage();
    await fetchOwners([ent('a'), ent('b', { requestable: true })]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(LINKED_SQL);
  });

  it('resolves a reference by external id first, then by an employee ID only one live account has', async () => {
    stage();
    await fetchOwners([ent('a', { ownerId: 'x' })]);
    const sql = query.mock.calls.find(([s]) => s.includes(REFERENCE_SQL))[0];
    expect(sql).toMatch(/by_external_id[\s\S]*p\."externalId" = r\.ref[\s\S]*\(p\."deletedAt" IS NULL\) DESC/);
    expect(sql).toMatch(/by_employee_id[\s\S]*p\."employeeId" = r\.ref AND p\."deletedAt" IS NULL/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM by_external_id x WHERE x\.ref = r\.ref\)/);
    expect(sql).toContain('HAVING count(*) = 1');
  });
});

describe('fetchResourceOwners — one resource, one entry per person', () => {
  it('lists every linked owner as its own entry and does not look at the reference', async () => {
    stage({ linked: [
      { id: 'r1', ownerId: 'p1', ownerName: 'A', ownerEmail: 'a@x', ownerEmployeeId: 'E1' },
      { id: 'r1', ownerId: 'p2', ownerName: 'B', ownerEmail: null, ownerEmployeeId: null },
    ] });
    expect(await fetchResourceOwners(ent('r1', { ownerId: 'spt-17' }))).toEqual([
      { principalId: 'p1', displayName: 'A', email: 'a@x', via: 'link' },
      { principalId: 'p2', displayName: 'B', email: null, via: 'link' },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([['r1']]);
  });

  it('resolves the source reference to an account when there is no link', async () => {
    stage({ references: [{ ref: 'spt-17', id: 'p9', displayName: 'Grace Hopper', email: 'g@x', employeeId: 'E-9' }] });
    expect(await fetchResourceOwners(ent('r1', { ownerId: 'spt-17', ownerName: 'Stale Name' })))
      .toEqual([{ principalId: 'p9', displayName: 'Grace Hopper', email: 'g@x', via: 'reference' }]);
    expect(query.mock.calls.find(([sql]) => sql.includes(REFERENCE_SQL))[1]).toEqual([['spt-17']]);
  });

  it('shows the source\'s own name, else its id, when no account matches — with nobody to open', async () => {
    stage();
    expect(await fetchResourceOwners(ent('r1', { ownerId: 'spt-404', ownerName: 'Gone Person' })))
      .toEqual([{ principalId: null, displayName: 'Gone Person', email: null, via: 'source' }]);
    expect(await fetchResourceOwners(ent('r1', { ownerId: 'spt-404' })))
      .toEqual([{ principalId: null, displayName: 'spt-404', email: null, via: 'source' }]);
  });

  it('takes a name without an id as-is, without asking who it resolves to', async () => {
    stage();
    expect(await fetchResourceOwners(ent('r1', { ownerName: 'Only A Name' })))
      .toEqual([{ principalId: null, displayName: 'Only A Name', email: null, via: 'source' }]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is empty, after one read, for a resource nobody owns', async () => {
    stage();
    expect(await fetchResourceOwners(ent('r1', { requestable: true }))).toEqual([]);
    expect(await fetchResourceOwners({ id: 'r2' })).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('linkedOwnerExistsSql', () => {
  it('is the live ownership chain, anchored on the caller\'s resource column', () => {
    const sql = linkedOwnerExistsSql('r.id');
    expect(sql).toMatch(/^SELECT 1/);
    expect(sql).toMatch(/lo\."resourceType" IN \('GroupOwnership','ServicePrincipalOwnership','ApplicationOwnership','ResourceOwnership'\)/);
    expect(sql).toContain('lo."deletedAt" IS NULL');
    expect(sql).toContain(`lra."assignmentType" = 'Direct'`);
    expect(sql).toContain('lra."deletedAt" IS NULL');
    expect(sql).toContain('lp."deletedAt" IS NULL');
    expect(sql).toMatch(/lrr\."relationshipType" IN \('HasOwnership','HasAppOwnership'\)/);
    expect(sql).toMatch(/lrr\."parentResourceId" = r\.id$/);
  });
});
