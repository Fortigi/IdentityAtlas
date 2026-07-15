import { describe, it, expect } from 'vitest';
import {
  buildAssignmentExprs,
  buildIdentityJoinExprs,
  buildRoleSubjectJoinExprs,
  buildApMemberExprs,
  mergeGroupTotals,
  resourceMeta,
} from './matrixHelpers.js';

describe('buildAssignmentExprs', () => {
  it('identity rowType: uses identityId and adds IdentityMembers join', () => {
    const result = buildAssignmentExprs('identity');
    expect(result.subjectIdExpr).toBe('im."identityId"');
    expect(result.assignmentJoin).toContain('IdentityMembers');
    expect(result.assignmentWhere).toHaveLength(1);
  });

  it('user rowType: uses principalId and no join', () => {
    const result = buildAssignmentExprs('user');
    expect(result.subjectIdExpr).toBe('p."principalId"');
    expect(result.assignmentJoin).toBe('');
  });

  it('adds subjectSql and resourceSql to where clause when provided', () => {
    // Fragments are now passed positionally as already-rendered $N strings.
    const result = buildAssignmentExprs('user', '(SELECT 1)', '(SELECT 2)');
    expect(result.assignmentWhere).toHaveLength(3);
  });
});

describe('buildIdentityJoinExprs', () => {
  it('identity rowType: adds IdentityMembers + Identities join and uses i.id', () => {
    const { join, subjectId } = buildIdentityJoinExprs('identity');
    expect(join).toContain('IdentityMembers');
    expect(join).toContain('Identities');
    expect(subjectId).toBe('i.id');
  });

  it('user rowType: no join, subjectId is nm.pid', () => {
    const { join, subjectId } = buildIdentityJoinExprs('user');
    expect(join).toBe('');
    expect(subjectId).toBe('nm.pid');
  });
});

describe('buildRoleSubjectJoinExprs', () => {
  it('identity rowType: three-way join and uses identity columns', () => {
    const { join, id, name, type } = buildRoleSubjectJoinExprs('identity');
    expect(join).toContain('Identities');
    expect(id).toBe('i.id');
    expect(name).toBe('i."displayName"');
    expect(type).toContain('Identity');
  });

  it('user rowType: single principal join and uses principal columns', () => {
    const { join, id, name, type } = buildRoleSubjectJoinExprs('user');
    expect(join).not.toContain('Identities');
    expect(id).toBe('u.id');
    expect(name).toBe('u."displayName"');
    expect(type).toContain('User');
  });
});

describe('buildApMemberExprs', () => {
  it('identity rowType: uses identityId and adds IdentityMembers join', () => {
    const { memberId, join } = buildApMemberExprs('identity');
    expect(memberId).toBe('im2."identityId"');
    expect(join).toContain('IdentityMembers');
  });

  it('user rowType: uses userId directly, no join', () => {
    const { memberId, join } = buildApMemberExprs('user');
    expect(memberId).toBe('br."userId"');
    expect(join).toBe('');
  });
});

describe('mergeGroupTotals', () => {
  it('returns base unchanged when inherited is empty', () => {
    const base = [{ groupValue: 'a', total: 5 }];
    expect(mergeGroupTotals(base, [])).toEqual(base);
  });

  it('returns base unchanged when inherited is null/undefined', () => {
    const base = [{ groupValue: 'a', total: 5 }];
    expect(mergeGroupTotals(base, null)).toEqual(base);
  });

  it('sums totals for matching groupValues', () => {
    const base = [{ groupValue: 'a', total: 5 }, { groupValue: 'b', total: 3 }];
    const inherited = [{ groupValue: 'a', total: 2 }, { groupValue: 'c', total: 7 }];
    const result = mergeGroupTotals(base, inherited);
    expect(result.find(r => r.groupValue === 'a').total).toBe(7);
    expect(result.find(r => r.groupValue === 'b').total).toBe(3);
    expect(result.find(r => r.groupValue === 'c').total).toBe(7);
  });
});

describe('resourceMeta', () => {
  it('extracts the standard 6-field resource metadata shape', () => {
    const row = {
      resourceId: 'r1', resourceDisplayName: 'My Role', resourceType: 'BusinessRole',
      resourceDescription: 'desc', systemId: 42, systemName: 'Entra',
      irrelevantField: 'ignored',
    };
    const meta = resourceMeta(row);
    expect(meta).toEqual({
      resourceId: 'r1', resourceDisplayName: 'My Role', resourceType: 'BusinessRole',
      resourceDescription: 'desc', systemId: 42, systemName: 'Entra',
    });
    expect(meta.irrelevantField).toBeUndefined();
  });
});
