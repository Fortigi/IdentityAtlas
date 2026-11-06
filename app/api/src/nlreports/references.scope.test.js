// Name lookups under a row scope: every statement a lookup runs carries the
// scope's predicate and parameter, so a name outside the scope is never found,
// never confirmed and never offered as "did you mean". Without a scope the
// statements are unchanged.

import { describe, it, expect, vi } from 'vitest';
import { searchNames, resolveNamedObjects } from './references.js';
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
    // Not found in scope → fuzzy choices, also in scope → "could not find".
    expect(out.confirm.message).toMatch(/could not find/);
    expect(calls).toHaveLength(2);
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

  it('runs unscoped without the option, as before', async () => {
    const { q, calls } = recorder(() => [{ id: 'g', displayName: 'Secret group', type: 'Group', exact: true }]);
    const out = await resolveNamedObjects(nameIs('Secret group'), q);
    expect(out.confirm).toBeNull();
    expect(calls[0].params).toHaveLength(2);
  });
});
