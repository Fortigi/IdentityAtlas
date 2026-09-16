import { describe, it, expect } from 'vitest';
import { buildRollupSql, buildRollupRolesSql, buildRolesAsRowsSql, buildGroupTotalsSql, buildRolesDrillSql } from './rollupBuilders.js';
import { GROUP_PRINCIPAL_TYPE } from '../lib/principalTypes.js';

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

// ── WHERE-clause assembly ───────────────────────────────────────────────────
// Every builder assembles its WHERE clause the same way: a list of conditions,
// pushed conditionally, joined with AND, and prefixed with WHERE only if the list
// is non-empty. All of it was unasserted, because the existing "omits the
// IN-clause" tests check `not.toMatch(/IN \(SELECT/)` — and that passes just as
// happily on the broken `p."principalId" IN null` that dropping the guard
// produces. Asserting the ABSENCE of one string says nothing about what is
// actually there.
//
// These assert the whole span between two fixed anchors instead, so anything
// injected into or dropped from the WHERE slot changes the result: a lost WHERE
// keyword, a lost AND (silently merging two conditions into nonsense), a
// condition added when nothing should be filtered, or the group-account exclusion
// disappearing — which would quietly count group accounts as people.
describe('WHERE-clause assembly', () => {
  const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

  // The generated text between `after` and `before`, whitespace-normalised.
  // Omitting `before` takes everything to the end of the statement.
  const between = (sql, after, before) => {
    const t = norm(sql);
    const a = t.indexOf(after);
    expect(a, `anchor not found: ${after}`).toBeGreaterThan(-1);
    const from = a + after.length;
    const b = before ? t.indexOf(before, from) : t.length;
    expect(b, `anchor not found: ${before}`).toBeGreaterThan(-1);
    return t.slice(from, b).trim();
  };

  const SUBJ = '(SELECT id FROM x)';
  const RES = '(SELECT id FROM y)';
  const base = {
    attrExpr: 'u."department"',
    subjectJoin: 'SJ', subjectIdExpr: 'p."principalId"', subjectIdForFilter: 'p."principalId"',
    subjectNameExpr: 'NEXP', subjectTypeExpr: 'TEXP',
    brMemberId: 'br."userId"', brJoin: 'BJ',
    subjectTable: 'Identities', subjectAlias: 'i',
    subjectSql: null, resourceSql: null,
  };

  // The group-account exclusion is the one condition that is always present, and
  // the only builder that carries it. Built from the imported constant so a rename
  // of the @odata.type moves the code and this expectation together.
  const NOT_A_GROUP =
    `(p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')`;

  const CASES = [
    {
      name: 'buildRollupSql',
      build: (over) => buildRollupSql({ ...base, ...over }),
      after: 'AND br."resourceId" = p."resourceId"',
      before: 'GROUP BY',
      unscoped: `WHERE ${NOT_A_GROUP} AND p."membershipType" = 'Direct'`,
      scoped: `WHERE ${NOT_A_GROUP} AND p."membershipType" = 'Direct'`
            + ` AND p."principalId" IN ${SUBJ} AND p."resourceId" IN ${RES}`,
      over: { subjectSql: SUBJ, resourceSql: RES },
    },
    {
      name: 'buildRollupRolesSql',
      build: (over) => buildRollupRolesSql({ ...base, ...over }),
      after: 'ON role.id = br."businessRoleId"',
      before: 'GROUP BY',
      unscoped: '',
      scoped: `WHERE br."userId" IN ${SUBJ} AND br."resourceId" IN ${RES}`,
      over: { subjectSql: SUBJ, resourceSql: RES },
    },
    {
      name: 'buildRolesAsRowsSql',
      build: (over) => buildRolesAsRowsSql({ ...base, ...over }),
      after: 'ON role.id = br."businessRoleId"',
      before: 'GROUP BY',
      unscoped: '',
      scoped: `WHERE p."principalId" IN ${SUBJ}`,
      over: { subjectSql: SUBJ },
    },
    {
      name: 'buildGroupTotalsSql',
      build: (over) => buildGroupTotalsSql({ ...base, ...over }),
      after: 'FROM "Identities" i',
      before: 'GROUP BY',
      unscoped: '',
      scoped: `WHERE i.id IN ${SUBJ}`,
      over: { subjectSql: SUBJ },
    },
    {
      // The one builder that can hold TWO conditions without a resource scope: on
      // the Principals table it also excludes group-shaped accounts. That is what
      // makes its AND separator reachable at all — over Identities there is only
      // ever one condition, so the join never uses it.
      name: 'buildGroupTotalsSql over Principals',
      build: (over) => buildGroupTotalsSql({ ...base, subjectTable: 'Principals', subjectAlias: 'p', ...over }),
      after: 'FROM "Principals" p',
      before: 'GROUP BY',
      unscoped: `WHERE (p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')`,
      scoped: `WHERE (p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')`
            + ` AND p.id IN ${SUBJ}`,
      over: { subjectSql: SUBJ },
    },
    {
      name: 'buildRolesDrillSql',
      build: (over) => buildRolesDrillSql({ ...base, ...over }),
      after: '"vw_UserPermissionAssignmentViaBusinessRole" br SJ',
      before: null,   // the WHERE clause ends this statement
      unscoped: '',
      scoped: `WHERE p."principalId" IN ${SUBJ}`,
      over: { subjectSql: SUBJ },
    },
  ];

  it.each(CASES)('$name filters on nothing extra when no scope is supplied', (c) => {
    expect(between(c.build({}), c.after, c.before)).toBe(c.unscoped);
  });

  it.each(CASES)('$name emits exactly the scoped conditions, joined and prefixed', (c) => {
    expect(between(c.build(c.over), c.after, c.before)).toBe(c.scoped);
  });
});
