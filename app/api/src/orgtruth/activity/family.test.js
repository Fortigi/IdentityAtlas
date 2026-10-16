import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { familyIndex, loadFamily, membershipIndex, keyOf } from './family.js';

// Ann: identity iA with accounts a1, a2. Bob: account b1 without identity.
const ROWS = [{ principalId: 'a1', identityId: 'iA' }, { principalId: 'a2', identityId: 'iA' }];

describe('familyIndex', () => {
  const family = familyIndex(ROWS);

  it('an account: itself, its identity and that identity\'s other accounts', () => {
    expect([...family('Principal', 'a1')].sort()).toEqual(['Identity:iA', 'Principal:a1', 'Principal:a2']);
  });

  it('an identity: itself and its accounts', () => {
    expect([...family('Identity', 'iA')].sort()).toEqual(['Identity:iA', 'Principal:a1', 'Principal:a2']);
  });

  it('a lone account, an unknown identity or any other kind: itself only', () => {
    expect([...family('Principal', 'b1')]).toEqual(['Principal:b1']);
    expect([...family('Identity', 'iX')]).toEqual(['Identity:iX']);
    // an id shared with an account is not widened for another type
    expect([...family('Resource', 'a1')]).toEqual(['Resource:a1']);
    expect([...family('OrgEntity', 'iA')]).toEqual(['OrgEntity:iA']);
  });
});

describe('loadFamily', () => {
  beforeEach(() => query.mockReset());

  it('reads the IdentityMembers rows touching the people among the refs, each id once', async () => {
    query.mockResolvedValueOnce({ rows: ROWS });
    const family = await loadFamily([
      { targetType: 'Principal', targetId: 'a1' }, { targetType: 'Identity', targetId: 'iA' },
      { targetType: 'Principal', targetId: 'a1' }, { targetType: 'Resource', targetId: 'r1' },
      { targetType: 'Principal', targetId: null },
    ]);
    expect(query.mock.calls[0][0]).toMatch(/WHERE "principalId" = ANY\(\$1::uuid\[\]\) OR "identityId" = ANY\(\$1::uuid\[\]\)/);
    expect(query.mock.calls[0][1]).toEqual([['a1', 'iA']]);
    expect(family('Principal', 'a2').has('Principal:a1')).toBe(true);
  });

  it('no people: no read, everybody is only themselves', async () => {
    const family = await loadFamily([{ targetType: 'OrgEntity', targetId: 'c1' }]);
    expect(query).not.toHaveBeenCalled();
    expect([...family('Principal', 'a1')]).toEqual(['Principal:a1']);
  });
});

describe('membershipIndex', () => {
  const family = familyIndex(ROWS);
  const rolesOf = membershipIndex([
    { via: 'team', targetType: 'Principal', targetId: 'a1' },
    { via: 'eigenaar', targetType: 'Identity', targetId: 'iA' },
    { via: 'team', targetType: 'Principal', targetId: 'b1' },
  ], family);

  it('a link to any record of the person counts, roles distinct and sorted', () => {
    expect(rolesOf('Principal', 'a2')).toEqual(['eigenaar', 'team']);
    expect(rolesOf('Identity', 'iA')).toEqual(['eigenaar', 'team']);
    expect(rolesOf('Principal', 'b1')).toEqual(['team']);
  });

  it('nobody else', () => {
    expect(rolesOf('Principal', 'c1')).toEqual([]);
    expect(keyOf('Principal', 'c1')).toBe('Principal:c1');
  });
});
