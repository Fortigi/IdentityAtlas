import { describe, it, expect } from 'vitest';
import { validateRecipe } from './recipe.js';
import {
  buildAccessQuery, buildDetailQuery, buildOrgCandidateQuery, buildOrgLinkQuery, loadOrgCandidates,
  loadPrincipalDetails, loadPrincipalSources, ORG_LINK_CHUNK, SAMPLE_SIZE,
} from './principalSql.js';

// These assert the parameters and the statement plumbing. Whether the SQL is right against
// the schema is not a unit-test question (the mocks are SQL-blind).
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principalRecipe = (extra = {}) => validateRecipe({ target: 'principal', terms: ['contoso', { text: 'fabrikam', state: 'rejected' }, 'ab'], ...extra }).recipe;

function recordingTx(rowsFor = () => []) {
  const seen = [];
  const tx = async (fn) => fn({ query: async (sql, params) => { seen.push({ sql, params }); return { rows: rowsFor(sql, params) }; } });
  return { tx, seen };
}

describe('buildOrgCandidateQuery', () => {
  it('searches with the kept terms only, and loads every pinned entity', () => {
    const q = buildOrgCandidateQuery(principalRecipe({ orgInclude: [ID(1)], orgExclude: [ID(2)] }));
    expect(q.params).toEqual([null, ['% contoso%', '% ab %'], [ID(1), ID(2)]]);
  });

  it('passes orgTypes as given: absent = every type (null), [] = none', () => {
    expect(buildOrgCandidateQuery(principalRecipe()).params[0]).toBeNull();
    expect(buildOrgCandidateQuery(principalRecipe({ orgTypes: [] })).params[0]).toEqual([]);
    expect(buildOrgCandidateQuery(principalRecipe({ orgTypes: ['Klant'] })).params[0]).toEqual(['Klant']);
  });

  it('asks for one row more than the limit, to tell a full page from a truncated one', () => {
    expect(buildOrgCandidateQuery(principalRecipe(), { limit: 7 }).text).toMatch(/LIMIT 8\s*$/);
  });
});

describe('buildOrgLinkQuery', () => {
  it('one part per entity, each binding its own entity id and type in order', () => {
    const q = buildOrgLinkQuery([{ id: ID(1), entityType: 'Klant' }, { id: ID(2), entityType: 'Project' }]);
    expect(q.text.split('UNION ALL\n')).toHaveLength(2);
    // entity id, then orgConditionClause's entityType and entityIds, per entity.
    expect(q.params).toEqual([ID(1), 'Klant', [ID(1)], ID(2), 'Project', [ID(2)]]);
    expect(q.text).toContain('SELECT $1::uuid AS "entityId"');
    expect(q.text).toContain('SELECT $4::uuid AS "entityId"');
  });

  it('leaves out an entity whose condition is dropped, without a stray parameter', () => {
    const q = buildOrgLinkQuery([{ id: ID(1), entityType: '' }, { id: ID(2), entityType: 'Klant' }]);
    expect(q.params).toEqual([ID(2), 'Klant', [ID(2)]]);
    expect(q.text).toContain('SELECT $1::uuid AS "entityId"');
    expect(buildOrgLinkQuery([{ id: ID(1), entityType: '' }])).toBeNull();
    expect(buildOrgLinkQuery([])).toBeNull();
  });
});

describe('buildAccessQuery / buildDetailQuery', () => {
  it('binds the resources and the assignment types', () => {
    expect(buildAccessQuery([ID(1)], ['Eligible']).params).toEqual([[ID(1)], ['Eligible']]);
  });

  it('limits the sample', () => {
    expect(SAMPLE_SIZE).toBe(200);
    expect(buildDetailQuery([ID(1)]).text).toMatch(/LIMIT 200\s*$/);
    expect(buildDetailQuery([ID(1)], 3).text).toMatch(/LIMIT 3\s*$/);
  });
});

describe('loaders', () => {
  it('reads read-only, with a statement timeout', async () => {
    const { tx, seen } = recordingTx();
    await loadOrgCandidates(principalRecipe(), tx);
    expect(seen.slice(0, 2).map(s => s.sql)).toEqual(['SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '15s'"]);
  });

  it('reports truncation only when more rows than the limit came back', async () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: ID(i) }));
    const at = await loadOrgCandidates(principalRecipe(), recordingTx(() => rows(3)).tx, { limit: 3 });
    const over = await loadOrgCandidates(principalRecipe(), recordingTx(() => rows(4)).tx, { limit: 3 });
    expect([at.rows.length, at.truncated]).toEqual([3, false]);
    expect([over.rows.length, over.truncated]).toEqual([3, true]);
  });

  it('asks access with the recipe assignment types — Eligible only when asked', async () => {
    for (const [types, expected] of [[undefined, ['Direct', 'Indirect']], [['Eligible'], ['Eligible']]]) {
      const { tx, seen } = recordingTx();
      await loadPrincipalSources(principalRecipe({ access: { assignmentTypes: types } }), [ID(1)], [], tx);
      expect(seen.find(s => s.sql.includes('ResourceAssignments')).params[1]).toEqual(expected);
    }
  });

  it('skips what there is nothing to ask for, and reads links in chunks', async () => {
    const entities = Array.from({ length: ORG_LINK_CHUNK + 1 }, (_, i) => ({ id: ID(i), entityType: 'Klant' }));
    const { tx, seen } = recordingTx((sql) => (sql.includes('AS "entityId"') ? [{ entityId: ID(0), principalId: ID(99) }] : []));
    const out = await loadPrincipalSources(principalRecipe(), [], entities, tx);
    expect(seen.some(s => s.sql.includes('ResourceAssignments'))).toBe(false);
    const linkStatements = seen.filter(s => s.sql.includes('AS "entityId"'));
    expect(linkStatements.map(s => s.params.length)).toEqual([ORG_LINK_CHUNK * 3, 3]);
    expect(out).toEqual({ accessRows: [], orgRows: [{ entityId: ID(0), principalId: ID(99) }, { entityId: ID(0), principalId: ID(99) }], included: [] });
  });

  it('keeps only the hand-picked users that exist', async () => {
    const { tx } = recordingTx((sql) => (sql.includes('SELECT p."id" FROM "Principals"') ? [{ id: ID(1) }] : []));
    const out = await loadPrincipalSources(principalRecipe({ principalInclude: [ID(1), ID(2)] }), [], [], tx);
    expect(out.included).toEqual([ID(1)]);
  });

  it('does not query names for an empty result', async () => {
    const { tx, seen } = recordingTx();
    expect(await loadPrincipalDetails([], tx)).toEqual([]);
    expect(seen).toEqual([]);
  });
});
