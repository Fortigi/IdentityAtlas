import { describe, it, expect } from 'vitest';
import { buildRollupSql, buildRollupRolesSql, buildRolesAsRowsSql, buildGroupTotalsSql, buildRolesDrillSql, normaliseSortAttributes } from './matrix.js';

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

  it('counts Direct-only subjects and a governed subset', () => {
    const sql = buildRollupSql(base);
    expect(sql).toContain(`p."membershipType" = 'Direct'`);
    expect(sql).toContain('COUNT(*)::int                          AS "directCount"');
    expect(sql).toContain('COUNT(*) FILTER (WHERE t.governed)::int AS "governedCount"');
    expect(sql).toContain('bool_or(br."userId" IS NOT NULL) AS governed');
    expect(sql).toContain('"vw_UserPermissionAssignmentViaBusinessRole"');
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

describe('buildRolesAsRowsSql', () => {
  const base = {
    attrExpr: 'u."department"',
    subjectJoin: 'INNER JOIN "Principals" u ON u.id = br."userId"',
    subjectIdExpr: 'u.id',
    subjectIdForFilter: 'u.id',
    subjectSql: null,
  };

  it('puts business roles on the rows, grouped by the attribute', () => {
    const sql = buildRolesAsRowsSql(base);
    expect(sql).toContain('br."businessRoleId" AS "roleId"');
    expect(sql).toContain('role."displayName"  AS "roleName"');
    expect(sql).toContain('role."description"  AS "roleDescription"');
    expect(sql).toContain('COUNT(DISTINCT u.id)::int AS "count"');
    expect(sql).toContain('"vw_UserPermissionAssignmentViaBusinessRole"');
    expect(sql).toContain('LEFT JOIN "Resources" role ON role.id = br."businessRoleId"');
    expect(sql).toMatch(/GROUP BY/);
  });

  it('groups by the resolved attribute with a (none) fallback', () => {
    const sql = buildRolesAsRowsSql(base);
    expect(sql).toContain(`COALESCE(NULLIF(u."department"::text, ''), '(none)')`);
  });

  it('embeds the subject IN-clause when present', () => {
    const sql = buildRolesAsRowsSql({ ...base, subjectSql: '(SELECT id FROM x)' });
    expect(sql).toContain('u.id IN (SELECT id FROM x)');
  });

  it('omits the IN-clause when no subject scope', () => {
    expect(buildRolesAsRowsSql(base)).not.toMatch(/IN \(SELECT/);
  });
});

describe('buildGroupTotalsSql', () => {
  it('counts distinct subjects per group from the subject table', () => {
    const sql = buildGroupTotalsSql({ attrExpr: 'u."department"', subjectTable: 'Principals', subjectAlias: 'u', subjectSql: null });
    expect(sql).toContain('COUNT(DISTINCT u.id)::int AS "total"');
    expect(sql).toContain('FROM "Principals" u');
    expect(sql).toContain(`COALESCE(NULLIF(u."department"::text, ''), '(none)')`);
    expect(sql).toMatch(/GROUP BY/);
  });

  it('excludes group-shaped principal accounts from the denominator', () => {
    const sql = buildGroupTotalsSql({ attrExpr: 'u."department"', subjectTable: 'Principals', subjectAlias: 'u', subjectSql: null });
    expect(sql).toContain(`u."principalType" != '#microsoft.graph.group'`);
  });

  it('does not apply the principal exclusion for identities', () => {
    const sql = buildGroupTotalsSql({ attrExpr: 'i."department"', subjectTable: 'Identities', subjectAlias: 'i', subjectSql: null });
    expect(sql).not.toContain('principalType');
    expect(sql).toContain('FROM "Identities" i');
  });

  it('embeds the subject IN-clause when scoped', () => {
    const sql = buildGroupTotalsSql({ attrExpr: 'i."department"', subjectTable: 'Identities', subjectAlias: 'i', subjectSql: '(SELECT id FROM x)' });
    expect(sql).toContain('i.id IN (SELECT id FROM x)');
  });
});

describe('buildRolesDrillSql', () => {
  const base = {
    subjectJoin: 'INNER JOIN "Principals" u ON u.id = br."userId"',
    subjectIdExpr: 'u.id',
    subjectNameExpr: 'u."displayName"',
    subjectTypeExpr: `'User'`,
    subjectIdForFilter: 'u.id',
    subjectSql: '(SELECT id FROM scope)',
  };

  it('returns each scoped subject and the business role they hold', () => {
    const sql = buildRolesDrillSql(base);
    expect(sql).toMatch(/u\.id\s+AS "memberId"/);
    expect(sql).toMatch(/u\."displayName"\s+AS "memberDisplayName"/);
    expect(sql).toMatch(/'User'\s+AS "memberType"/);
    expect(sql).toMatch(/br\."businessRoleId"\s+AS "roleId"/);
    expect(sql).toContain('"vw_UserPermissionAssignmentViaBusinessRole"');
    expect(sql).toContain('u.id IN (SELECT id FROM scope)');
    expect(sql).toMatch(/SELECT DISTINCT/);
  });

  it('uses the identity member expr when drilling identities', () => {
    const sql = buildRolesDrillSql({ ...base, subjectIdExpr: 'i.id', subjectNameExpr: 'i."displayName"', subjectTypeExpr: `'Identity'`, subjectIdForFilter: 'i.id' });
    expect(sql).toMatch(/i\.id\s+AS "memberId"/);
    expect(sql).toMatch(/'Identity'\s+AS "memberType"/);
  });

  it('omits the WHERE clause when unscoped', () => {
    expect(buildRolesDrillSql({ ...base, subjectSql: null })).not.toMatch(/WHERE/);
  });
});
