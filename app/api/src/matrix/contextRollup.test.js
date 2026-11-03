import { describe, it, expect } from 'vitest';
import {
  isUuid, frontierValues, buildContextRollupSql, buildContextTotalsSql,
  buildContextNodesSql, buildContextChildrenSql, buildRootChildrenSql,
  buildContextRolesSql, buildContextRolesAsRowsSql,
  buildContextCutSql, buildContextScopedMemberCountsSql,
  withDirectMemberNodes, frontierOf, directGroupValue, contextIdOfGroup,
} from './contextRollup.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('isUuid / frontierValues', () => {
  it('accepts UUIDs and rejects junk', () => {
    expect(isUuid(A)).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid("a'); DROP TABLE x;--")).toBe(false);
  });

  it('builds a typed VALUES body from validated ids: (id, group value, walk the subtree?)', () => {
    expect(frontierValues([A, B])).toBe(`('${A}'::uuid, '${A}', true), ('${B}'::uuid, '${B}', true)`);
  });

  it('a direct-members entry counts only its unit: its own group value, no walk', () => {
    expect(frontierValues([{ id: A.toUpperCase(), direct: true }, B])).toBe(
      `('${A.toUpperCase()}'::uuid, '${A}:direct', false), ('${B}'::uuid, '${B}', true)`);
  });

  it('validates the id of a direct-members entry too', () => {
    expect(() => frontierValues([{ id: "x')--", direct: true }])).toThrow('invalid context id');
    expect(() => frontierValues([null])).toThrow();
  });

  it('throws on a non-UUID id (injection guard)', () => {
    expect(() => frontierValues([A, "x'::uuid),((SELECT 1"])).toThrow();
    expect(() => frontierValues([])).toThrow();
  });
});

describe('buildContextCutSql', () => {
  it('descends only through expanded nodes and emits non-expanded nodes with their path', () => {
    const sql = buildContextCutSql(A, [B]);
    expect(sql).toContain(`WHERE c."parentContextId" = '${A}'::uuid`); // root's children
    expect(sql).toContain(`expanded(id) AS ( VALUES ('${B}'::uuid) )`); // the expanded set
    expect(sql).toMatch(/WITH RECURSIVE/);
    expect(sql).toContain('path_ids');
    expect(sql).toContain('path_names');
    // descend only into expanded nodes; emit only non-expanded (uses EXISTS, not NOT IN NULL)
    expect(sql).toContain('WHERE EXISTS (SELECT 1 FROM expanded e WHERE e.id = cut.id)');
    expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM expanded e WHERE e.id = cut.id)');
    expect(sql).toContain('ORDER BY cut.path_names');
  });

  it('uses a NULL sentinel when nothing is expanded (so the cut = the root level)', () => {
    const sql = buildContextCutSql(A, []);
    expect(sql).toContain('expanded(id) AS ( VALUES (NULL::uuid) )');
  });

  it('throws on a non-UUID root or expanded id (injection guard)', () => {
    expect(() => buildContextCutSql('bad', [])).toThrow();
    expect(() => buildContextCutSql(A, ["x'); DROP TABLE y;--"])).toThrow();
  });
});

describe('buildContextScopedMemberCountsSql', () => {
  const base = { values: frontierValues([A]), subjectId: 'nm.pid', subjectScope: 'nm.pid', subjectSql: null, resourceSql: null };

  it('splits scoped members into direct (at the node) vs total (whole subtree)', () => {
    const sql = buildContextScopedMemberCountsSql(base);
    expect(sql).toContain('member_dir');
    expect(sql).toContain('bool_or(s.lvl = 0) AS is_direct');
    expect(sql).toContain('WHERE s.deep');
    expect(sql).toContain('COUNT(DISTINCT nm.pid)::int AS "total"');
    expect(sql).toContain('FILTER (WHERE nm.is_direct)::int AS "direct"');
    expect(sql).toContain(`p."membershipType" = 'Direct'`);
    expect(sql).toContain('"vw_ResourceUserPermissionAssignments"');
  });

  it('embeds the subject and resource IN-clauses when scoped', () => {
    const sql = buildContextScopedMemberCountsSql({ ...base, subjectSql: '(SELECT id FROM x)', resourceSql: '(SELECT id FROM y)' });
    expect(sql).toContain('nm.pid IN (SELECT id FROM x)');
    expect(sql).toContain('p."resourceId" IN (SELECT id FROM y)');
  });

  it('joins identities through the supplied identity join', () => {
    const sql = buildContextScopedMemberCountsSql({ ...base, identityJoin: 'JOIN "Identities" i ON i.id = nm.pid', subjectId: 'i.id', subjectScope: 'i.id' });
    expect(sql).toContain('JOIN "Identities" i ON i.id = nm.pid');
    expect(sql).toContain('COUNT(DISTINCT i.id)::int AS "total"');
  });
});

describe('buildContextRollupSql', () => {
  const base = { values: frontierValues([A]), subjectId: 'nm.pid', subjectScope: 'nm.pid', subjectSql: null, resourceSql: null };

  it('walks the subtree and counts distinct Direct subjects per frontier node', () => {
    const sql = buildContextRollupSql(base);
    expect(sql).toContain('WITH RECURSIVE frontier(fid, gv, deep) AS');
    expect(sql).toContain('WHERE s.deep');
    expect(sql).toContain('JOIN subtree s ON c."parentContextId" = s.ctx_id');
    expect(sql).toContain(`cm."memberType" = 'Principal'`);
    expect(sql).toContain(`p."membershipType" = 'Direct'`);
    expect(sql).toContain('COUNT(DISTINCT nm.pid)::int AS "directCount"');
    expect(sql).toContain('FILTER (WHERE br."userId" IS NOT NULL)::int AS "governedCount"');
    expect(sql).toContain('nm.fid::text            AS "groupValue"');
  });

  it('adds the identity join + counts identities when supplied', () => {
    const sql = buildContextRollupSql({ ...base, identityJoin: 'JOIN "IdentityMembers" im ON im."principalId" = nm.pid JOIN "Identities" i ON i.id = im."identityId"', subjectId: 'i.id', subjectScope: 'i.id' });
    expect(sql).toContain('JOIN "IdentityMembers" im');
    expect(sql).toContain('COUNT(DISTINCT i.id)::int AS "directCount"');
  });

  it('embeds subject + resource scope IN-clauses when present', () => {
    const sql = buildContextRollupSql({ ...base, subjectSql: '(SELECT id FROM s)', resourceSql: '(SELECT id FROM r)' });
    expect(sql).toContain('nm.pid IN (SELECT id FROM s)');
    expect(sql).toContain('p."resourceId" IN (SELECT id FROM r)');
  });
});

describe('buildContextTotalsSql', () => {
  it('counts distinct subjects per node subtree (denominator)', () => {
    const sql = buildContextTotalsSql({ values: frontierValues([A]), subjectId: 'nm.pid', subjectScope: 'nm.pid', subjectSql: '(SELECT id FROM s)' });
    expect(sql).toContain('COUNT(DISTINCT nm.pid)::int AS "total"');
    expect(sql).toContain('nm.pid IN (SELECT id FROM s)');
    expect(sql).toMatch(/GROUP BY nm\.fid/);
  });
});

describe('buildContextRolesSql (business-role columns)', () => {
  const base = { values: frontierValues([A]), subjectId: 'nm.pid', subjectScope: 'nm.pid', subjectSql: null, resourceSql: null };
  it('counts distinct subjects per (resource, business role) over the frontier', () => {
    const sql = buildContextRolesSql(base);
    expect(sql).toContain('WITH RECURSIVE frontier(fid, gv, deep) AS');
    expect(sql).toContain('"vw_UserPermissionAssignmentViaBusinessRole"');
    expect(sql).toContain('br."resourceId"      AS "resourceId"');
    expect(sql).toContain('br."businessRoleId"  AS "roleId"');
    expect(sql).toContain('COUNT(DISTINCT nm.pid)::int AS "count"');
    expect(sql).toContain('SELECT DISTINCT fid, pid FROM node_members');
  });
  it('embeds subject + resource scope', () => {
    const sql = buildContextRolesSql({ ...base, subjectSql: '(SELECT id FROM s)', resourceSql: '(SELECT id FROM r)' });
    expect(sql).toContain('nm.pid IN (SELECT id FROM s)');
    expect(sql).toContain('br."resourceId" IN (SELECT id FROM r)');
  });
});

describe('buildContextRolesAsRowsSql (roles-only)', () => {
  it('puts business roles on the rows × org-unit columns', () => {
    const sql = buildContextRolesAsRowsSql({ values: frontierValues([A]), subjectId: 'nm.pid', subjectScope: 'nm.pid', subjectSql: '(SELECT id FROM s)' });
    expect(sql).toContain('br."businessRoleId" AS "roleId"');
    expect(sql).toContain('nm.fid::text        AS "groupValue"');
    expect(sql).toContain('COUNT(DISTINCT nm.pid)::int AS "count"');
    expect(sql).toContain('nm.pid IN (SELECT id FROM s)');
    expect(sql).toMatch(/GROUP BY br\."businessRoleId"/);
  });
});

describe('node + children + root-children queries', () => {
  it('selects frontier node metadata with a childCount subquery', () => {
    const sql = buildContextNodesSql([A, B]);
    expect(sql).toContain(`c.id IN ('${A}'::uuid, '${B}'::uuid)`);
    expect(sql).toContain('AS "childCount"');
  });

  it('selects children of frontier nodes, biggest subtree first', () => {
    const sql = buildContextChildrenSql([A]);
    expect(sql).toContain(`c."parentContextId" IN ('${A}'::uuid)`);
    expect(sql).toMatch(/ORDER BY c\."totalMemberCount" DESC/);
  });

  it('builds the default-frontier (root children) query', () => {
    expect(buildRootChildrenSql(A)).toContain(`"parentContextId" = '${A}'::uuid`);
    expect(() => buildRootChildrenSql('bad')).toThrow();
  });
});

describe('withDirectMemberNodes — a unit\'s own members beside its sub-units', () => {
  const C = '33333333-3333-3333-3333-333333333333';
  const D = '44444444-4444-4444-4444-444444444444';
  const root = { id: A, displayName: 'CTO' };

  it('a leaf root: only its direct-members column', () => {
    expect(withDirectMemberNodes([], root)).toEqual([{
      id: `${A}:direct`, directOf: A, displayName: 'CTO — direct members',
      depth: 1, pathIds: [`${A}:direct`], pathNames: ['CTO — direct members'], childCount: 0,
    }]);
  });

  it('the root column first, then the sub-units; an expanded unit column before its own sub-units', () => {
    const cut = [
      { id: C, depth: 2, pathIds: [B, C], pathNames: ['Dev', 'Dev team'] },
      { id: D, depth: 2, pathIds: [B, D], pathNames: ['Dev', 'Dev ops'] },
    ];
    const out = withDirectMemberNodes(cut, root, [B.toUpperCase()]);
    expect(out.map(n => n.id)).toEqual([`${A}:direct`, `${B}:direct`, C, D]);
    expect(out[1]).toMatchObject({ directOf: B, depth: 2, pathIds: [B, `${B}:direct`], pathNames: ['Dev', 'Dev — direct members'] });
  });

  it('no column for a unit that is not expanded', () => {
    const out = withDirectMemberNodes([{ id: C, depth: 2, pathIds: [B, C], pathNames: ['Dev', 'Dev team'] }], root, []);
    expect(out.map(n => n.id)).toEqual([`${A}:direct`, C]);
  });

  it('frontierOf: a direct-members column counts its unit only, the rest their subtree', () => {
    expect(frontierOf(withDirectMemberNodes([{ id: C, pathIds: [C] }], root))).toEqual([{ id: A, direct: true }, C]);
  });

  it('a group value names its unit back', () => {
    expect(contextIdOfGroup(directGroupValue(A.toUpperCase()))).toBe(A);
    expect(contextIdOfGroup(B)).toBe(B);
  });
});
