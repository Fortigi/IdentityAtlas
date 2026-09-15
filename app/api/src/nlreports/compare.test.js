import { describe, it, expect, vi } from 'vitest';
import { validateSpec } from './spec.js';
import { compileSpec } from './compile.js';
import { explainSpec } from './explain.js';
import { resolveReferences, referenceProblemText, baseEntityOf } from './compare.js';

const BR_ID = 'd2d71e57-329f-4ce0-9836-43c622ed41b1';
const ROLE_MINING = {
  entity: 'group',
  conditions: [
    { type: 'compare', relation: 'members', measure: 'identical', minSimilarity: 100, reference: { entity: 'resource', name: 'Fortigi - Algemeen - Maten' } },
    { relation: 'businessRoles', quantifier: 'none', conditions: [{ field: 'displayName', op: 'eq', value: 'Fortigi - Algemeen - Maten' }] },
  ],
};

const valid = (raw) => {
  const r = validateSpec(raw);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.spec;
};

describe('compare — validation', () => {
  it('normalises the role-mining question and adds the comparison columns', () => {
    const spec = valid(ROLE_MINING);
    expect(spec.conditions[0]).toEqual({
      type: 'compare', relation: 'members', measure: 'identical',
      reference: { entity: 'resource', name: 'Fortigi - Algemeen - Maten' },
    });
    expect(spec.columns).toEqual(['displayName', 'description', 'memberCount', 'compare.similarity', 'compare.onlyHereNames', 'compare.onlyReferenceNames']);
  });

  it('infers the type, defaults minSimilarity to 80 for "similar" and keeps an explicit percentage', () => {
    const base = { relation: 'memberOf', reference: { entity: 'users', name: 'Jan' } };
    expect(valid({ entity: 'user', conditions: [{ ...base, measure: 'similar' }] }).conditions[0].minSimilarity).toBe(80);
    expect(valid({ entity: 'user', conditions: [{ ...base, measure: 'similar', minSimilarity: 65.4 }] }).conditions[0].minSimilarity).toBe(65);
    expect(valid({ entity: 'user', conditions: [{ ...base, measure: 'containsAll', minSimilarity: 50 }] }).conditions[0]).not.toHaveProperty('minSimilarity');
  });

  it('rejects what cannot be compared, with a message the model can act on', () => {
    const errs = (c, entity = 'user') => validateSpec({ entity, conditions: [c] }).errors[0];
    expect(errs({ type: 'compare', relation: 'manager', measure: 'identical', reference: { entity: 'user', name: 'x' } })).toMatch(/compare needs one of these relations of user: directReports, memberOf, access, owns/);
    expect(errs({ type: 'compare', relation: 'memberOf', measure: 'same', reference: { entity: 'user', name: 'x' } })).toMatch(/measure must be one of/);
    expect(errs({ type: 'compare', relation: 'memberOf', measure: 'identical', reference: { entity: 'group', name: 'x' } })).toMatch(/a group has no "memberOf"/);
    expect(errs({ type: 'compare', relation: 'memberOf', measure: 'identical', reference: { entity: 'user', name: '  ' } })).toMatch(/needs the name/);
    expect(errs({ type: 'compare', relation: 'memberOf', measure: 'similar', minSimilarity: 0, reference: { entity: 'user', name: 'x' } })).toMatch(/between 1 and 100/);
    expect(errs({ relation: 'manager', conditions: [{ type: 'compare', relation: 'memberOf', measure: 'identical', reference: { entity: 'user', name: 'x' } }] }))
      .toMatch(/cannot be nested/);
  });

  it('drops comparison columns from a report that does not compare', () => {
    expect(valid({ entity: 'group', columns: ['displayName', 'compare.similarity'] }).columns).toEqual(['displayName']);
  });
});

describe('compare — SQL', () => {
  const resolved = () => {
    const spec = valid(ROLE_MINING);
    spec.conditions[0].reference.id = BR_ID;
    spec.conditions[0].reference.type = 'BusinessRole';
    return spec;
  };

  it('refuses to compile an unresolved reference', () => {
    expect(() => compileSpec(valid(ROLE_MINING))).toThrow(/must be resolved/);
  });

  it('computes the reference set once, excludes the reference itself and sorts by similarity', () => {
    const { text, params, columns } = compileSpec(resolved());
    expect(text.startsWith('WITH ref0 AS (SELECT DISTINCT')).toBe(true);
    expect(text.match(/ref0 AS \(/g)).toHaveLength(1);
    expect(text).toMatch(/t0\."id" <> \$\d+::uuid/);
    expect(params.filter(p => p === BR_ID).length).toBeGreaterThanOrEqual(2);
    expect(text).toMatch(/ORDER BY round\(100\.0 \*[\s\S]*DESC NULLS LAST, t0\."displayName"/);
    expect(columns.map(c => c.label)).toEqual(['Name', 'Description', 'Member count', 'Similarity %', 'Only here (names)', 'Missing vs "Fortigi - Algemeen - Maten"']);
  });

  it('expresses each measure as its set relation', () => {
    const sqlFor = (measure) => {
      const spec = resolved();
      Object.assign(spec.conditions[0], { measure, minSimilarity: 75 });
      spec.sort = { field: 'displayName', direction: 'asc' };
      return compileSpec(spec).text;
    };
    expect(sqlFor('identical')).toMatch(/> 0 AND \(SELECT count\(\*\) FROM \(SELECT DISTINCT[\s\S]*\) c\) = \(SELECT count\(\*\) FROM ref0\) AND/);
    expect(sqlFor('containsAll')).toMatch(/\(SELECT count\(\*\) FROM ref0\) > 0 AND \(SELECT count\(\*\) FROM \([\s\S]*WHERE c\.id IN \(SELECT id FROM ref0\)\) = \(SELECT count\(\*\) FROM ref0\)\)/);
    // "within" guards on the row's own set being non-empty, not on the reference's.
    expect(sqlFor('within')).toMatch(/\) c\) > 0 AND/);
    expect(sqlFor('within')).not.toMatch(/FROM ref0\) > 0/);
    expect(sqlFor('similar')).toMatch(/\* 100 >= \$\d+::int \*/);
  });

  it('excludes the reference record itself when it is in the same table as the rows', () => {
    const spec = valid({ entity: 'user', conditions: [{ type: 'compare', relation: 'memberOf', measure: 'identical', reference: { entity: 'user', name: 'Jan' } }] });
    spec.conditions[0].reference.id = BR_ID;
    expect(compileSpec(spec).text).toMatch(/t0\."id" <> /); // same table (Principals) → excluded

    const cross = valid({ entity: 'group', conditions: [{ type: 'compare', relation: 'members', measure: 'identical', reference: { entity: 'group', name: 'G' } }] });
    cross.conditions[0].reference.id = BR_ID;
    expect(compileSpec(cross).text).toMatch(/t0\."id" <> /);
  });
});

describe('compare — plain language', () => {
  it('names the reference by its type', () => {
    const spec = valid(ROLE_MINING);
    Object.assign(spec.conditions[0].reference, { id: BR_ID, type: 'BusinessRole' });
    expect(explainSpec(spec).lines[0].text).toBe('has exactly the same members as business role "Fortigi - Algemeen - Maten"');
    spec.conditions[0].measure = 'similar';
    spec.conditions[0].minSimilarity = 80;
    expect(explainSpec(spec).lines[0].text).toBe('shares at least 80% of its members with business role "Fortigi - Algemeen - Maten"');
  });
});

describe('compare — reference resolution', () => {
  const specFor = (name, entity = 'group') => valid({ entity: 'group', conditions: [{ type: 'compare', relation: 'members', measure: 'identical', reference: { entity, name } }] });

  it('falls back from "group" to any resource, and prefers an exact name', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // exact, as a group
      .mockResolvedValueOnce({ rows: [{ id: BR_ID, displayName: 'Fortigi - Algemeen - Maten', type: 'BusinessRole' }] }); // exact, any resource
    const spec = specFor('fortigi - algemeen - maten');
    expect(await resolveReferences(spec, query)).toEqual({ problems: [] });
    expect(spec.conditions[0].reference).toEqual({ entity: 'resource', name: 'Fortigi - Algemeen - Maten', id: BR_ID, type: 'BusinessRole' });
    expect(query.mock.calls[0][1]).toEqual(['fortigi - algemeen - maten']);
    expect(baseEntityOf('group')).toBe('resource');
  });

  it('asks which one when a partial name matches several records', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) // no exact match anywhere
      .mockResolvedValueOnce({ rows: [{ id: 'a', displayName: 'Fortigi - Algemeen - Maten' }, { id: 'b', displayName: 'Fortigi - Algemeen - Maten en Associates' }] });
    const { problems } = await resolveReferences(specFor('Maten'), query);
    expect(problems).toEqual([{ kind: 'ambiguous', name: 'Maten', label: 'group', options: ['Fortigi - Algemeen - Maten', 'Fortigi - Algemeen - Maten en Associates'] }]);
    expect(query.mock.calls[2][1]).toEqual(['%Maten%']);
    expect(referenceProblemText(problems[0])).toBe('Which group do you mean by "Maten"?');
  });

  it('reports a name that matches nothing', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const { problems } = await resolveReferences(specFor('Nope'), query);
    expect(referenceProblemText(problems[0])).toBe('I could not find a group named "Nope". What is its exact name?');
  });

  it('keeps a stored id and refreshes the name after a rename', async () => {
    const spec = specFor('Old name', 'resource');
    spec.conditions[0].reference.id = BR_ID;
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: BR_ID, displayName: 'New name', type: 'BusinessRole' }] });
    await resolveReferences(spec, query);
    expect(spec.conditions[0].reference).toMatchObject({ id: BR_ID, name: 'New name' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
