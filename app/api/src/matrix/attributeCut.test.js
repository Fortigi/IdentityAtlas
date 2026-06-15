import { describe, it, expect } from 'vitest';
import {
  visibleKeyExpr, buildAttrCutCellsSql, buildAttrCutNodesSql, tupleToNode, TUPLE_SEP,
} from './attributeCut.js';

const E = ['u."division"', 'u."department"', 'u."jobTitle"'];

describe('visibleKeyExpr', () => {
  it('is just the first attribute when nothing is expanded', () => {
    const sql = visibleKeyExpr(E, []);
    expect(sql).toContain(`COALESCE(NULLIF(u."division"::text, ''), '(none)')`);
    expect(sql).not.toContain('CASE');
  });

  it('descends through expanded prefixes with a CASE, capped at the deepest attribute', () => {
    const sql = visibleKeyExpr(E, ['@exp0', '@exp1']);
    expect(sql).toMatch(/^CASE /);
    // one WHEN per non-leaf level (division, division+department)
    expect((sql.match(/WHEN /g) || []).length).toBe(2);
    expect(sql).toContain('NOT IN (@exp0, @exp1)');
    expect(sql).toContain('chr(31)');
    expect(sql).toMatch(/ELSE .* END$/);
  });

  it('never has a WHEN for a single attribute', () => {
    expect(visibleKeyExpr(['u."division"'], ['@exp0'])).not.toContain('CASE');
  });
});

describe('buildAttrCutCellsSql', () => {
  const base = {
    attrExprs: E,
    subjectJoin: 'INNER JOIN "Principals" u ON p."principalId" = u.id',
    subjectIdExpr: 'p."principalId"',
    subjectIdForFilter: 'p."principalId"',
    subjectSql: null, resourceSql: null,
  };

  it('counts Direct subjects per (resource, visible tuple)', () => {
    const sql = buildAttrCutCellsSql(base);
    expect(sql).toContain(`p."membershipType" = 'Direct'`);
    expect(sql).toContain('COUNT(*)::int                          AS "directCount"');
    expect(sql).toContain('COUNT(*) FILTER (WHERE t.governed)::int AS "governedCount"');
    expect(sql).toContain('"vw_ResourceUserPermissionAssignments"');
    expect(sql).toMatch(/GROUP BY/);
    expect(sql).toContain('"groupValue"');
  });

  it('embeds the subject and resource IN-clauses when present', () => {
    const sql = buildAttrCutCellsSql({ ...base, subjectSql: '(SELECT id FROM x)', resourceSql: '(SELECT id FROM y)' });
    expect(sql).toContain('p."principalId" IN (SELECT id FROM x)');
    expect(sql).toContain('p."resourceId" IN (SELECT id FROM y)');
  });
});

describe('buildAttrCutNodesSql', () => {
  const base = {
    attrExprs: E,
    subjectTable: 'Principals', subjectAlias: 'u',
    subjectIdExpr: 'u.id', subjectIdForFilter: 'u.id',
    subjectSql: null, excludeGroups: true,
  };

  it('returns per-tuple total + childCount (distinct next-attribute values)', () => {
    const sql = buildAttrCutNodesSql(base);
    expect(sql).toContain('COUNT(DISTINCT s.sid)::int AS "total"');
    expect(sql).toContain('COUNT(DISTINCT s.nv)::int  AS "childCount"');
    expect(sql).toContain('string_to_array');
    expect(sql).toContain(`u."principalType" != '#microsoft.graph.group'`);
    expect(sql).toMatch(/GROUP BY s\.gk/);
  });

  it('embeds the subject IN-clause when scoped', () => {
    expect(buildAttrCutNodesSql({ ...base, subjectSql: '(q)' })).toContain('u.id IN (q)');
  });
});

describe('tupleToNode', () => {
  it('splits a tuple key into its ancestor path + depth', () => {
    const key = ['Commercie', 'Sales', 'Rep'].join(TUPLE_SEP);
    const n = tupleToNode(key, 34, 0);
    expect(n.depth).toBe(3);
    expect(n.pathNames).toEqual(['Commercie', 'Sales', 'Rep']);
    expect(n.displayName).toBe('Rep');
    expect(n.total).toBe(34);
    expect(n.childCount).toBe(0);
  });
});
