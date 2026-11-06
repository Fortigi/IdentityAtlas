// Name lookups under a row scope: every statement a lookup runs carries the
// scope's predicate and parameter, so a name outside the scope is never found,
// never confirmed and never offered as "did you mean". Without a scope the
// statements are unchanged.

import { describe, it, expect, vi } from 'vitest';
import { searchNames, resolveNamedObjects, namesOutsideScope } from './references.js';
import { scopePredicate } from './scope.js';

const IDS = ['a0000000-0000-4000-8000-000000000001'];
const SCOPE = { basis: 'context-owner', contextIds: IDS };

const recorder = (rowsFor = () => []) => {
  const calls = [];
  const q = vi.fn(async (sql, params) => { calls.push({ sql, params }); return { rows: rowsFor(sql, params) }; });
  return { q, calls };
};

describe('searchNames', () => {
  it('restricts the fuzzy search to the scope, with the ids as its last parameter', async () => {
    const { q, calls } = recorder();
    await searchNames(q, 'account', 'Olga', SCOPE);
    expect(calls[0].sql).toContain(scopePredicate('Principals', 'n0', '$3::uuid[]'));
    expect(calls[0].params).toEqual(['Olga', '%Olga%', IDS]);
  });

  it('scopes contexts by id', async () => {
    const { q, calls } = recorder();
    await searchNames(q, 'context', 'Finance', SCOPE);
    expect(calls[0].sql).toContain('n0."id" = ANY($3::uuid[])');
  });

  it('leaves an unscoped search exactly as it was', async () => {
    const { q, calls } = recorder();
    await searchNames(q, 'account', 'Olga');
    expect(calls[0].params).toEqual(['Olga', '%Olga%']);
    expect(calls[0].sql).not.toContain('::uuid[]');
  });
});

describe('resolveNamedObjects', () => {
  const nameIs = (value) => ({ entity: 'group', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value }] });

  it('looks an exact name up inside the scope only, and offers only in-scope choices', async () => {
    const { q, calls } = recorder();
    const out = await resolveNamedObjects(nameIs('Secret group'), q, { scope: SCOPE });
    // Not found in scope, not named outside it either → fuzzy choices in scope → "could not find".
    expect(out.confirm.message).toMatch(/could not find/);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.sql).toContain('::uuid[]');
      expect(c.params.at(-1)).toEqual(IDS);
    }
  });

  it('scopes a person lookup ("name contains") and a reference given by id', async () => {
    const { q, calls } = recorder(() => []);
    await resolveNamedObjects({ entity: 'user', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'bram' }] }, q, { scope: SCOPE });
    expect(calls[0].sql).toContain(scopePredicate('Principals', 'n0', '$2::uuid[]'));
    expect(calls[0].params).toEqual(['%bram%', IDS]);

    const ref = recorder(() => []);
    await resolveNamedObjects({ entity: 'user', conditions: [{ type: 'compare', relation: 'groups', measure: 'containsAll', reference: { entity: 'user', name: 'X', id: IDS[0] } }] }, ref.q, { scope: SCOPE });
    expect(ref.calls[0].sql).toContain(scopePredicate('Principals', 'n0', '$2::uuid[]'));
    expect(ref.calls.every(c => c.params.at(-1) === IDS)).toBe(true);
  });

  // A recorder whose answer depends on which lookup runs: the out-of-scope one is the only NOT (…) statement.
  const lookups = ({ inScope = [], outside = [] }) => recorder((sql) => (sql.includes('AND NOT ') ? outside : inScope));

  it('says a name that exists only outside the scope EXISTS — name and type, no id', async () => {
    const { q, calls } = lookups({ outside: [{ displayName: 'Olga Outsider', type: 'User' }] });
    const out = await resolveNamedObjects({ entity: 'user', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'olga outsider' }] }, q, { scope: SCOPE });
    expect(out.confirm).toMatchObject({ kind: 'outOfScope', outsideScope: [{ name: 'Olga Outsider', type: 'User' }] });
    expect(out.confirm.message).toBe('User "Olga Outsider" exists in Identity Atlas, but lies outside the part you may see, so no details about it can be shown.');
    expect(JSON.stringify(out.confirm.outsideScope)).not.toMatch(/"id"/);
    const outsideSql = calls.find(c => c.sql.includes('AND NOT ')).sql;
    expect(outsideSql).toContain(`NOT ${scopePredicate('Principals', 'n0', '$3::uuid[]')}`);
  });

  it('prefers an exact in-scope match and never asks outside then', async () => {
    const { q, calls } = lookups({ inScope: [{ id: 'p', displayName: 'Ann', type: 'User', exact: true }], outside: [{ displayName: 'Ann', type: 'User' }] });
    expect((await resolveNamedObjects({ entity: 'user', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'Ann' }] }, q, { scope: SCOPE })).confirm).toBeNull();
    expect(calls.some(c => c.sql.includes('AND NOT '))).toBe(false);
  });

  it('tells a person lookup ("name contains") the same, when the full name is outside', async () => {
    const { q } = lookups({ outside: [{ displayName: 'Abigail Davies', type: 'User' }] });
    const out = await resolveNamedObjects({ entity: 'user', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Abigail Davies' }] }, q, { scope: SCOPE });
    expect(out.confirm.kind).toBe('outOfScope');
  });

  it('never confirms a context name outside the scope, and never asks outside without a scope', async () => {
    const { q, calls } = lookups({ outside: [{ displayName: 'Secret unit', type: null }] });
    expect(await namesOutsideScope(q, 'context', 'Secret unit', SCOPE)).toEqual([]);
    expect(await namesOutsideScope(q, 'user', 'Secret unit', null)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('runs unscoped without the option, as before', async () => {
    const { q, calls } = recorder(() => [{ id: 'g', displayName: 'Secret group', type: 'Group', exact: true }]);
    const out = await resolveNamedObjects(nameIs('Secret group'), q);
    expect(out.confirm).toBeNull();
    expect(calls[0].params).toHaveLength(2);
  });
});
