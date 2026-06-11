import { describe, it, expect } from 'vitest';
import { buildRollupSql, buildRollupRolesSql, normaliseSortAttributes } from './matrix.js';

describe('normaliseSortAttributes', () => {
  it('defaults to [department asc] when missing or empty', () => {
    expect(normaliseSortAttributes(undefined)).toEqual([{ attribute: 'department', dir: 'asc' }]);
    expect(normaliseSortAttributes([])).toEqual([{ attribute: 'department', dir: 'asc' }]);
    expect(normaliseSortAttributes('nope')).toEqual([{ attribute: 'department', dir: 'asc' }]);
  });

  it('keeps valid entries and normalises dir', () => {
    expect(normaliseSortAttributes([
      { attribute: 'department', dir: 'desc' },
      { attribute: 'jobTitle' },
    ])).toEqual([
      { attribute: 'department', dir: 'desc' },
      { attribute: 'jobTitle', dir: 'asc' },
    ]);
  });

  it('caps at 3 attributes', () => {
    const out = normaliseSortAttributes([
      { attribute: 'a' }, { attribute: 'b' }, { attribute: 'c' }, { attribute: 'd' },
    ]);
    expect(out).toHaveLength(3);
    expect(out.map(a => a.attribute)).toEqual(['a', 'b', 'c']);
  });

  it('drops entries with no attribute string', () => {
    expect(normaliseSortAttributes([{ dir: 'asc' }, { attribute: '' }, { attribute: 'x' }]))
      .toEqual([{ attribute: 'x', dir: 'asc' }]);
  });
});

describe('buildRollupSql', () => {
  const base = {
    attrExpr: 'u."department"',
    subjectJoin: 'INNER JOIN "Principals" u ON p."principalId" = u.id',
    subjectIdExpr: 'p."principalId"',
    subjectIdForFilter: 'p."principalId"',
    subjectSql: null,
    resourceSql: null,
  };

  it('counts DISTINCT subjects with a Direct assignment only', () => {
    const sql = buildRollupSql(base);
    expect(sql).toContain(`p."membershipType" = 'Direct'`);
    expect(sql).toContain('COUNT(DISTINCT p."principalId")::int AS "directCount"');
    expect(sql).toMatch(/GROUP BY/);
    expect(sql).toContain('"vw_ResourceUserPermissionAssignments"');
  });

  it('groups by the resolved attribute with a (none) fallback', () => {
    const sql = buildRollupSql(base);
    expect(sql).toContain(`COALESCE(NULLIF(u."department"::text, ''), '(none)')`);
  });

  it('embeds the subject and resource IN-clauses when present', () => {
    const sql = buildRollupSql({ ...base, subjectSql: '(SELECT id FROM x)', resourceSql: '(SELECT id FROM y)' });
    expect(sql).toContain('p."principalId" IN (SELECT id FROM x)');
    expect(sql).toContain('p."resourceId" IN (SELECT id FROM y)');
  });

  it('omits IN-clauses when no scope subqueries', () => {
    const sql = buildRollupSql(base);
    expect(sql).not.toMatch(/IN \(SELECT/);
  });
});

describe('buildRollupRolesSql', () => {
  const base = { brMemberId: 'br."userId"', brJoin: '', subjectSql: null, resourceSql: null };

  it('counts distinct subjects per (resource, business role)', () => {
    const sql = buildRollupRolesSql(base);
    expect(sql).toContain('COUNT(DISTINCT br."userId")::int AS "count"');
    expect(sql).toContain('"vw_UserPermissionAssignmentViaBusinessRole"');
    expect(sql).toMatch(/GROUP BY/);
    expect(sql).toContain('br."businessRoleId"');
  });

  it('embeds the subject and resource IN-clauses when present', () => {
    const sql = buildRollupRolesSql({ ...base, subjectSql: '(SELECT id FROM x)', resourceSql: '(SELECT id FROM y)' });
    expect(sql).toContain('br."userId" IN (SELECT id FROM x)');
    expect(sql).toContain('br."resourceId" IN (SELECT id FROM y)');
  });

  it('uses the identity member expr + join when supplied', () => {
    const sql = buildRollupRolesSql({ brMemberId: 'im2."identityId"', brJoin: 'INNER JOIN "IdentityMembers" im2 ON im2."principalId" = br."userId"', subjectSql: '(q)', resourceSql: null });
    expect(sql).toContain('COUNT(DISTINCT im2."identityId")');
    expect(sql).toContain('INNER JOIN "IdentityMembers" im2');
    expect(sql).toContain('im2."identityId" IN (q)');
  });
});
