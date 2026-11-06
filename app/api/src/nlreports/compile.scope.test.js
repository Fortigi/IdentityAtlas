// The compiler under a row scope (scope.js): the scope must sit on the report's
// own table AND inside every relation — as a condition and as every kind of
// relation column — and nowhere may it be missing. Walks the whole catalog, so a
// relation added tomorrow is covered without editing this file. An unscoped
// compile must not change by a byte.

import { describe, it, expect } from 'vitest';
import { compileSpec, SCOPED_COMPARE_ERROR } from './compile.js';
import { ENTITIES } from './catalog.js';
import { scopePredicate } from './scope.js';

const IDS = ['a0000000-0000-4000-8000-000000000001'];
const SCOPE = { basis: 'context-owner', contextIds: IDS };
const REF = '$1::uuid[]';

const spec = (entity, extra = {}) => ({ entity, match: 'all', conditions: [], columns: [], limit: 10, ...extra });
const relationCondition = (relation, conditions = []) => ({ type: 'relation', relation, quantifier: 'some', match: 'all', conditions });

// Does the SQL restrict SOME alias of `table` to the scope?
const scopesSomeAlias = (sql, table) => Array.from({ length: 40 }, (_, i) => scopePredicate(table, `t${i}`, REF)).some(p => sql.includes(p));
const scopedAliasCount = (sql, table) => Array.from({ length: 40 }, (_, i) => scopePredicate(table, `t${i}`, REF)).filter(p => sql.includes(p)).length;

const relations = Object.entries(ENTITIES).flatMap(([entity, e]) => Object.entries(e.relations).map(([name, rel]) => ({ entity, name, rel })));

describe('without a scope', () => {
  it('compiles byte for byte as before, with no scope parameter', () => {
    const s = spec('group', { conditions: [relationCondition('members')], columns: ['displayName', 'members.names'] });
    const plain = compileSpec(s, {});
    expect(compileSpec(s, {}, {})).toEqual(plain);
    expect(compileSpec(s, {}, { scope: null })).toEqual(plain);
    expect(plain.text).not.toContain('::uuid[]');
    expect(plain.params).not.toContainEqual(IDS);
  });
});

describe('with a scope', () => {
  it('passes the context ids as the FIRST parameter, once', () => {
    const c = compileSpec(spec('user', { conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'a' }] }), {}, { scope: SCOPE });
    expect(c.params[0]).toEqual(IDS);
    expect(c.params.filter(p => p === IDS || (Array.isArray(p) && p[0] === IDS[0]))).toHaveLength(1);
  });

  it.each(Object.keys(ENTITIES))('restricts the report\'s own table for %s', (entity) => {
    const c = compileSpec(spec(entity), {}, { scope: SCOPE });
    expect(c.text).toContain(scopePredicate(ENTITIES[entity].table, 't0', REF));
  });

  it('restricts a grouped count before it counts', () => {
    const c = compileSpec(spec('user', { groupBy: 'department', columns: [] }), {}, { scope: SCOPE });
    const where = c.text.slice(c.text.indexOf('WHERE'), c.text.indexOf('GROUP BY'));
    expect(where).toContain(scopePredicate('Principals', 't0', REF));
  });

  it('refuses a comparison instead of running half of it unscoped', () => {
    const s = spec('user', { conditions: [{ type: 'compare', relation: 'groups', measure: 'containsAll', reference: { entity: 'user', name: 'X', id: IDS[0] } }] });
    expect(() => compileSpec(s, {}, { scope: SCOPE })).toThrow(SCOPED_COMPARE_ERROR);
  });
});

describe('every relation of the catalog', () => {
  it.each(relations.map(r => [`${r.entity}.${r.name}`, r]))('%s reads its target table through the alias the scope is put on', (_label, { rel }) => {
    const { from } = rel.from('outer', 'inner', () => 'extra');
    expect(from).toContain(`"${ENTITIES[rel.target].table}" inner`);
  });

  it.each(relations.map(r => [`${r.entity}.${r.name}`, r]))('%s is scoped as a condition', (_label, { entity, name, rel }) => {
    const c = compileSpec(spec(entity, { conditions: [relationCondition(name)] }), {}, { scope: SCOPE });
    const table = ENTITIES[rel.target].table;
    // The root is one scoped alias; the relation's target must be another one.
    const expected = table === ENTITIES[entity].table ? 2 : 1;
    expect(scopedAliasCount(c.text, table)).toBeGreaterThanOrEqual(expected);
  });

  it.each(relations.map(r => [`${r.entity}.${r.name}`, r]))('%s is scoped in every column it offers', (_label, { entity, name, rel }) => {
    const refs = rel.cardinality === 'many' ? [`${name}.names`, `${name}.count`] : [`${name}.displayName`];
    const table = ENTITIES[rel.target].table;
    for (const ref of refs) {
      const c = compileSpec(spec(entity, { columns: [ref] }), {}, { scope: SCOPE });
      const base = table === ENTITIES[entity].table ? 1 : 0;
      // A name list adds a second subquery for its ids: both must be scoped.
      const subqueries = ref.endsWith('.names') ? 2 : 1;
      expect(scopedAliasCount(c.text, table) - base).toBeGreaterThanOrEqual(subqueries);
      expect(scopesSomeAlias(c.text, table)).toBe(true);
    }
  });
});
