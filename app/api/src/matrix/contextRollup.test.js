import { describe, it, expect } from 'vitest';
import {
  isUuid, frontierValues, buildContextRollupSql, buildContextTotalsSql,
  buildContextNodesSql, buildContextChildrenSql, buildRootChildrenSql,
} from './contextRollup.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('isUuid / frontierValues', () => {
  it('accepts UUIDs and rejects junk', () => {
    expect(isUuid(A)).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid("a'); DROP TABLE x;--")).toBe(false);
  });

  it('builds a typed VALUES body from validated ids', () => {
    expect(frontierValues([A, B])).toBe(`('${A}'::uuid), ('${B}'::uuid)`);
  });

  it('throws on a non-UUID id (injection guard)', () => {
    expect(() => frontierValues([A, "x'::uuid),((SELECT 1"])).toThrow();
    expect(() => frontierValues([])).toThrow();
  });
});

describe('buildContextRollupSql', () => {
  const base = { values: frontierValues([A]), subjectId: 'nm.pid', subjectScope: 'nm.pid', subjectSql: null, resourceSql: null };

  it('walks the subtree and counts distinct Direct subjects per frontier node', () => {
    const sql = buildContextRollupSql(base);
    expect(sql).toContain('WITH RECURSIVE frontier(fid) AS');
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
