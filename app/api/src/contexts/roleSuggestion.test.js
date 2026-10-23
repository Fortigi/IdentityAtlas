// Unit tests for contexts/roleSuggestion.js — the best guess for a missing
// Accountable. DB mocked: what the SQL selects against real data is only
// meaningful against PostgreSQL; here we pin the decisions around it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';
import { pickCandidate, share, suggestAccountable, SIGNALS, SUGGESTION_THRESHOLD } from './roleSuggestion.js';
import { OWNERSHIP_RESOURCE_TYPES, OWNERSHIP_RELATIONSHIP_TYPES } from '../lib/ownershipTypes.js';

const CTX = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P1  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('pickCandidate', () => {
  const c = (id, count) => ({ id, displayName: id, count });

  it('the threshold is 40 %', () => {
    expect(SUGGESTION_THRESHOLD).toBe(0.4);
  });

  it('suggests a candidate at exactly 40 % and refuses one just below', () => {
    expect(pickCandidate([c('a', 4)], 10)).toEqual(c('a', 4));
    expect(pickCandidate([c('a', 2)], 5)).toEqual(c('a', 2));
    expect(pickCandidate([c('a', 3)], 8)).toBeNull();     // 37.5 %
    expect(pickCandidate([c('a', 39)], 100)).toBeNull();
  });

  it('picks the candidate with the most members wherever it sits in the list', () => {
    expect(pickCandidate([c('a', 2), c('b', 5), c('c', 3)], 10)).toEqual(c('b', 5));
  });

  it('on a tie keeps the earlier candidate', () => {
    expect(pickCandidate([c('a', 5), c('b', 5)], 10).id).toBe('a');
  });

  it('judges the best candidate only: a weaker one never passes in its place', () => {
    // b is the best but below 40 %; a passes nothing either.
    expect(pickCandidate([c('a', 1), c('b', 3)], 10)).toBeNull();
  });

  it.each([[0], [undefined], [null], [-1]])('no members (total %s) → null', (total) => {
    expect(pickCandidate([c('a', 4)], total)).toBeNull();
  });

  it('no candidates → null', () => {
    expect(pickCandidate([], 10)).toBeNull();
  });
});

describe('SIGNALS — the SQL per kind of member', () => {
  it('people: the manager identity of the members, skipping rejected identities', () => {
    const { sql, holderCol } = SIGNALS.Identity;
    expect(holderCol).toBe('identityId');
    expect(sql).toContain('JOIN "Identities" e ON e.id = cm."memberId"');
    expect(sql).toContain('JOIN "Identities" m ON m.id = e."managerIdentityId"');
    expect(sql).toContain(`cm."memberType" = 'Identity'`);
    expect(sql).toContain(`x.role = 'Accountable' AND x."identityId" = m.id`);
    // Identities has no soft delete.
    expect(sql).not.toContain('deletedAt');
  });

  it('accounts: the manager principal of the members, live rows only, skipping rejected principals', () => {
    const { sql, holderCol } = SIGNALS.Principal;
    expect(holderCol).toBe('principalId');
    expect(sql).toContain('JOIN "Principals" e ON e.id = cm."memberId" AND e."deletedAt" IS NULL');
    expect(sql).toContain('JOIN "Principals" m ON m.id = e."managerId" AND m."deletedAt" IS NULL');
    expect(sql).toContain(`cm."memberType" = 'Principal'`);
    expect(sql).toContain(`x."principalId" = m.id`);
  });

  it('resources: the holders of the ownership resources linked from the members', () => {
    const { sql, holderCol } = SIGNALS.Resource;
    expect(holderCol).toBe('principalId');
    expect(sql).toContain(`rr."relationshipType" IN (${OWNERSHIP_RELATIONSHIP_TYPES.map(t => `'${t}'`).join(',')})`);
    expect(sql).toContain(`o."resourceType" IN (${OWNERSHIP_RESOURCE_TYPES.map(t => `'${t}'`).join(',')})`);
    expect(sql).toContain('rr."parentResourceId" = cm."memberId"');
    expect(sql).toContain('o.id = rr."childResourceId"');
    expect(sql).toContain(`ra."assignmentType" = 'Direct' AND ra."deletedAt" IS NULL`);
    // A resource with two ownership links still counts once.
    expect(sql).toContain('COUNT(DISTINCT cm."memberId")');
    expect(sql).toContain(`x."principalId" = p.id`);
  });

  it('every signal orders the most covering candidate first, deterministically, and takes one', () => {
    for (const { sql } of Object.values(SIGNALS)) {
      expect(sql).toMatch(/ORDER BY count DESC, \w\."displayName", \w\.id\s+LIMIT 1/);
      expect(sql).toContain('x."contextId" = $1');
    }
  });

  it('a System context has no signal', () => {
    expect(Object.keys(SIGNALS).sort()).toEqual(['Identity', 'Principal', 'Resource']);
  });
});

describe('suggestAccountable', () => {
  it('suggests the manager of 11 of 14 accounts with the reason', async () => {
    queryOne.mockResolvedValueOnce({ total: 14 });
    query.mockResolvedValueOnce({ rows: [{ id: P1, displayName: 'Boss', count: 11 }] });
    expect(await suggestAccountable({ id: CTX, targetType: 'Principal' })).toEqual({
      role: 'Accountable', principalId: P1, displayName: 'Boss',
      reason: 'manages 11 of the 14 members', count: 11, total: 14,
    });
    expect(queryOne.mock.calls[0][0]).toContain('FROM "ContextMembers" WHERE "contextId" = $1 AND "memberType" = $2');
    expect(queryOne.mock.calls[0][1]).toEqual([CTX, 'Principal']);
    expect(query.mock.calls[0]).toEqual([SIGNALS.Principal.sql, [CTX]]);
  });

  it('a people unit answers with an identityId, not a principalId', async () => {
    queryOne.mockResolvedValueOnce({ total: 5 });
    query.mockResolvedValueOnce({ rows: [{ id: P1, displayName: 'Jan', count: 2 }] });
    const s = await suggestAccountable({ id: CTX, targetType: 'Identity' });
    expect(s).toMatchObject({ identityId: P1, reason: 'manages 2 of the 5 members' });
    expect(s).not.toHaveProperty('principalId');
    expect(query.mock.calls[0][0]).toBe(SIGNALS.Identity.sql);
  });

  it('a resource unit names the owner of its resources', async () => {
    queryOne.mockResolvedValueOnce({ total: 6 });
    query.mockResolvedValueOnce({ rows: [{ id: P1, displayName: 'Owner', count: 4 }] });
    const s = await suggestAccountable({ id: CTX, targetType: 'Resource' });
    expect(s).toMatchObject({ principalId: P1, reason: 'owns 4 of the 6 resources', count: 4, total: 6 });
    expect(query.mock.calls[0][0]).toBe(SIGNALS.Resource.sql);
  });

  it('a unit of one member says "the only member", not "1 of the 1"', async () => {
    queryOne.mockResolvedValueOnce({ total: 1 });
    query.mockResolvedValueOnce({ rows: [{ id: P1, displayName: 'Manager', count: 1 }] });
    const s = await suggestAccountable({ id: CTX, targetType: 'Principal' });
    expect(s.reason).toBe('manages the only member');
  });
});

describe('share', () => {
  it.each([
    [1, 1, 'member', 'the only member'],
    [3, 3, 'resource', 'all 3 resources'],
    [3, 4, 'member', '3 of the 4 members'],
    [1, 2, 'resource', '1 of the 2 resources'],
  ])('%i of %i %s → %s', (count, total, noun, expected) => {
    expect(share(count, total, noun)).toBe(expected);
  });

  it('null below the threshold', async () => {
    queryOne.mockResolvedValueOnce({ total: 14 });
    query.mockResolvedValueOnce({ rows: [{ id: P1, displayName: 'Boss', count: 5 }] });
    expect(await suggestAccountable({ id: CTX, targetType: 'Principal' })).toBeNull();
  });

  it('null when no candidate comes back (all rejected, or nobody has a manager)', async () => {
    queryOne.mockResolvedValueOnce({ total: 3 });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await suggestAccountable({ id: CTX, targetType: 'Identity' })).toBeNull();
  });

  it.each([[{ total: 0 }], [null]])('no members of that kind (%o) → null without the candidate query', async (row) => {
    queryOne.mockResolvedValueOnce(row);
    expect(await suggestAccountable({ id: CTX, targetType: 'Resource' })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('a target type without a signal → null without touching the database', async () => {
    expect(await suggestAccountable({ id: CTX, targetType: 'System' })).toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
