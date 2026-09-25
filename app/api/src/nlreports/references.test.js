import { describe, it, expect, vi } from 'vitest';
import { validateSpec } from './spec.js';
import { compileSpec } from './compile.js';
import { explainSpec } from './explain.js';
import { baseEntityOf } from './compare.js';
import { applyChoice, normalizeName, resolveNamedObjects } from './references.js';
import { GLOSSARY } from './catalog.js';

const BR = { id: 'd2d71e57-329f-4ce0-9836-43c622ed41b1', displayName: 'ACME - Algemeen - Partners', type: 'BusinessRole' };
const valid = (raw) => {
  const r = validateSpec(raw);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.spec;
};
const compareSpec = (name, entity = 'group') => valid({
  entity: 'group',
  conditions: [{ type: 'compare', relation: 'members', measure: 'identical', reference: { entity, name } }],
});
// Queries are recognised by what they do, so a test states "no exact match, these fuzzy ones".
const db = ({ exact = () => [], fuzzy = () => [], byId = () => [] } = {}) => vi.fn(async (sql, params) => {
  if (sql.includes('"id" = $1')) return { rows: byId(params) };
  if (sql.includes('similarity(')) return { rows: fuzzy(params) };
  return { rows: exact(params) };
});

describe('resolveNamedObjects — compare references', () => {
  it('uses an exact name silently, falling back from group to any resource', async () => {
    const query = db();
    query.mockImplementationOnce(async () => ({ rows: [] })) // exact, as a group
      .mockImplementationOnce(async () => ({ rows: [{ ...BR, exact: true }] })); // exact, any resource
    const spec = compareSpec('acme - algemeen - partners');
    expect(await resolveNamedObjects(spec, query)).toEqual({ confirm: null });
    expect(spec.conditions[0].reference).toEqual({ entity: 'resource', name: BR.displayName, id: BR.id, type: 'BusinessRole' });
    expect(baseEntityOf('group')).toBe('resource');
  });

  it('accepts a name that differs only in spaces and punctuation, without asking', async () => {
    const query = db({ exact: () => [{ ...BR, exact: false }] });
    const spec = compareSpec('ACME Algemeen Partners', 'resource');
    expect((await resolveNamedObjects(spec, query)).confirm).toBeNull();
    expect(spec.conditions[0].reference.name).toBe(BR.displayName);
    expect(query.mock.calls[0][1]).toEqual(['ACME Algemeen Partners', 'acmealgemeenpartners']);
  });

  it('asks the analyst to confirm a fuzzy match, labelled by the type it found', async () => {
    const choices = [{ id: BR.id, displayName: BR.displayName, type: 'BusinessRole', score: '0.61' }, { id: 'x', displayName: 'ACME.Partners', type: 'Group', score: '0.4' }];
    const query = db({ fuzzy: () => choices });
    const { confirm } = await resolveNamedObjects(compareSpec('Algemene partners', 'resource'), query);
    expect(confirm).toEqual({
      kind: 'reference', path: [0], name: 'Algemene partners', label: 'business role',
      message: 'No business role is named exactly "Algemene partners". Did you mean:',
      choices: [
        { id: BR.id, name: BR.displayName, type: 'BusinessRole', score: 0.61 },
        { id: 'x', name: 'ACME.Partners', type: 'Group', score: 0.4 },
      ],
    });
    expect(query.mock.calls.at(-1)[1]).toEqual(['Algemene partners', '%Algemene partners%']);
  });

  it('asks for the exact name when nothing is close', async () => {
    const { confirm } = await resolveNamedObjects(compareSpec('Nope', 'resource'), db());
    expect(confirm).toMatchObject({ choices: [], message: 'I could not find any resource named "Nope". What is its exact name?' });
  });

  it('lets the analyst pick between two records with the same name', async () => {
    const twins = [{ ...BR, exact: true }, { ...BR, id: 'twin', exact: true }];
    const { confirm } = await resolveNamedObjects(compareSpec(BR.displayName, 'resource'), db({ exact: () => twins }));
    expect(confirm.choices.map(c => c.id)).toEqual([BR.id, 'twin']);
  });

  it('keeps a stored id and refreshes the name after a rename', async () => {
    const spec = compareSpec('Old name', 'resource');
    spec.conditions[0].reference.id = BR.id;
    const query = db({ byId: () => [{ ...BR, displayName: 'New name' }] });
    expect((await resolveNamedObjects(spec, query)).confirm).toBeNull();
    expect(spec.conditions[0].reference).toMatchObject({ id: BR.id, name: 'New name' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('resolveNamedObjects — "name is X" conditions', () => {
  const notInRole = (name) => valid({
    entity: 'group',
    conditions: [
      { type: 'field', field: 'displayName', op: 'contains', value: 'LIC' }, // a fragment is never looked up
      { type: 'group', match: 'any', conditions: [
        { relation: 'businessRoles', quantifier: 'none', conditions: [{ field: 'displayName', op: 'eq', value: name }] },
      ] },
    ],
  });

  it('checks the name against the entity the condition is about, at its path', async () => {
    const query = db({ fuzzy: () => [{ id: BR.id, displayName: BR.displayName, type: 'BusinessRole', score: '0.7' }] });
    const { confirm } = await resolveNamedObjects(notInRole('ACME Algemene Partners'), query);
    expect(confirm).toMatchObject({ kind: 'value', path: [1, 0, 0], label: 'business role' });
    expect(query).toHaveBeenCalledTimes(2); // exact + fuzzy, only for the eq condition
    // Looked up among resources (the relation target), not among groups — a business role is not a group.
    expect(query.mock.calls[0][0]).not.toMatch(/= 'Group'/);
  });

  it('passes a name that exists, and never looks at a name the analyst chose to keep', async () => {
    expect((await resolveNamedObjects(notInRole(BR.displayName), db({ exact: () => [{ ...BR, exact: true }] }))).confirm).toBeNull();
    const kept = notInRole('Not a real role');
    kept.conditions[1].conditions[0].conditions[0].checked = true;
    const query = db();
    expect((await resolveNamedObjects(valid(kept), query)).confirm).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('applyChoice', () => {
  it('pins a compare reference to the chosen record, or clears the id for a typed name', () => {
    const spec = compareSpec('Algemene partners', 'resource');
    expect(applyChoice(spec, { path: [0], name: BR.displayName, id: BR.id })).toBe(true);
    expect(spec.conditions[0].reference).toEqual({ entity: 'resource', name: BR.displayName, id: BR.id });
    expect(applyChoice(spec, { path: [0], name: '  Typed name ' })).toBe(true);
    expect(spec.conditions[0].reference).toEqual({ entity: 'resource', name: 'Typed name' });
  });

  it('replaces a nested "name is" value, or keeps it as written — the choice\'s label never replaces it', () => {
    const nested = () => valid({ entity: 'group', conditions: [{ relation: 'businessRoles', quantifier: 'none', conditions: [{ field: 'displayName', op: 'eq', value: 'x' }] }] });
    const typed = nested();
    expect(applyChoice(typed, { path: [0, 0], name: 'Typed name' })).toBe(true);
    expect(typed.conditions[0].conditions[0]).toEqual({ type: 'field', field: 'displayName', op: 'eq', value: 'Typed name' });

    // "Keep as written" is a choice whose name is only its label ("every
    // account with … in the name"); the value stays what the model wrote.
    const kept = nested();
    expect(applyChoice(kept, { path: [0, 0], name: 'Keep “x” as written', keep: true })).toBe(true);
    expect(kept.conditions[0].conditions[0]).toEqual({ type: 'field', field: 'displayName', op: 'eq', value: 'x', checked: true });
    expect(valid(kept).conditions[0].conditions[0].checked).toBe(true); // survives re-validation
  });

  it('refuses a path or answer that does not point at a named object', () => {
    const spec = compareSpec('x', 'resource');
    expect(applyChoice(spec, { path: [5], name: 'a' })).toBe(false);
    expect(applyChoice(spec, { path: [0], name: '  ' })).toBe(false);
    expect(applyChoice(spec, null)).toBe(false);
    expect(applyChoice(valid({ entity: 'user', conditions: [{ field: 'email', op: 'eq', value: 'a' }] }), { path: [0], name: 'b' })).toBe(false);
  });

  it('follows only whole, in-range positions, so a crafted path cannot reach a prototype', () => {
    // The path comes from the browser. "__proto__" on an array is Array.prototype,
    // whose own entries would then be written to.
    const spec = compareSpec('x', 'resource');
    for (const path of [['__proto__'], ['constructor', 'prototype'], ['0'], [-1], [0.5], [1]]) {
      expect(applyChoice(spec, { path, name: 'polluted', id: 'p' }), JSON.stringify(path)).toBe(false);
    }
    expect({}.name).toBeUndefined();
    expect([].reference).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('value');
    expect(spec.conditions[0].reference.name).toBe('x');   // the real condition was not touched either
  });
});

describe('identities and the glossary', () => {
  it('normalises names the same way the database does', () => {
    expect(normalizeName('ACME - Algemeen - Partners')).toBe(normalizeName('acme.algemeen.partners'));
    expect(normalizeName('Café Élan')).toBe('caféélan');
  });

  it('compiles persons, their accounts and the person behind an account', () => {
    const persons = valid({ entity: 'persons', conditions: [{ relation: 'accounts', conditions: [{ field: 'accountEnabled', op: 'eq', value: false }] }], columns: ['displayName', 'accounts.names', 'manager.displayName'] });
    expect(persons.entity).toBe('identity');
    const { text } = compileSpec(persons);
    expect(text).toMatch(/FROM "Identities" t0\nWHERE TRUE AND EXISTS \(SELECT 1 FROM "IdentityMembers" t\d+ JOIN "Principals"/);
    expect(explainSpec(persons).lines[0].text).toBe('has an account where Enabled is No');

    const unlinked = valid({ entity: 'user', conditions: [{ relation: 'identity', quantifier: 'none', conditions: [] }] });
    expect(compileSpec(unlinked).text).toMatch(/NOT EXISTS \(SELECT 1 FROM "IdentityMembers" t\d+ JOIN "Identities"/);
    expect(explainSpec(unlinked).lines[0].text).toBe('is not linked to any person');
  });

  it('maps every glossary term to exactly one meaning', () => {
    const terms = GLOSSARY.flatMap(g => g.terms.map(t => t.toLowerCase()));
    expect(new Set(terms).size).toBe(terms.length);
    expect(GLOSSARY.find(g => g.terms.includes('access package')).terms).toContain('business role');
    expect(GLOSSARY.find(g => g.terms.includes('person')).means).toMatch(/identity entity/);
    expect(GLOSSARY.find(g => g.terms.includes('principal')).terms).toEqual(expect.arrayContaining(['account', 'user']));
  });
});

describe('resolveNamedObjects — a person written as "name contains X"', () => {
  // The lookup is recognised by its running total; nothing else is queried
  // unless the person is not found.
  const persons = (rows, fuzzy = []) => vi.fn(async (sql) => {
    if (sql.includes('OVER()')) return { rows: rows.map(r => ({ ...r, total: rows.length })) };
    if (sql.includes('similarity(')) return { rows: fuzzy };
    return { rows: [] };
  });
  const degroot = { id: 'u1', displayName: 'Bram de Groot', type: 'User' };
  const smit = { id: 'u2', displayName: 'Bram Smit', type: 'User' };
  const bram = (entity = 'user') => valid({ entity, conditions: [{ field: 'displayName', op: 'contains', value: 'bram' }] });

  it('pins a single match to that person, so the report says who it is about', async () => {
    const spec = bram();
    const query = persons([degroot]);
    expect((await resolveNamedObjects(spec, query)).confirm).toBeNull();
    expect(spec.conditions[0]).toEqual({ type: 'field', field: 'displayName', op: 'eq', value: 'Bram de Groot', checked: true });
    expect(query).toHaveBeenCalledTimes(1);
    // The pinned condition survives a second look-up untouched.
    expect((await resolveNamedObjects(spec, query)).confirm).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('asks which one when several match, offering everyone with the name as the LAST choice', async () => {
    const { confirm } = await resolveNamedObjects(bram(), persons([degroot, smit]));
    expect(confirm).toMatchObject({ kind: 'person', path: [0], name: 'bram', total: 2 });
    expect(confirm.message).toMatch(/^2 users have "bram"/);
    expect(confirm.choices.slice(0, 2)).toEqual([
      { id: 'u1', name: 'Bram de Groot', type: 'User' },
      { id: 'u2', name: 'Bram Smit', type: 'User' },
    ]);
    expect(confirm.choices.at(-1)).toEqual({ name: 'every user with “bram” in the name', keep: true });
  });

  it('asks for the exact name when nobody matches, with the fuzzy suggestions', async () => {
    const { confirm } = await resolveNamedObjects(bram(), persons([], [{ id: 'u1', displayName: 'Bram de Grot', type: 'User', score: '0.5' }]));
    expect(confirm).toMatchObject({ kind: 'value', name: 'bram', choices: [{ id: 'u1', name: 'Bram de Grot' }] });
  });

  it('looks a person up on the entity the condition is about — the members of a group', async () => {
    const spec = valid({
      entity: 'group',
      conditions: [
        { field: 'displayName', op: 'contains', value: 'License' }, // a group fragment: a filter, not a lookup
        { relation: 'members', quantifier: 'some', conditions: [{ field: 'displayName', op: 'contains', value: 'bram' }] },
      ],
    });
    const query = persons([degroot]);
    expect((await resolveNamedObjects(spec, query)).confirm).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('"Principals"');
    expect(spec.conditions[0]).toMatchObject({ op: 'contains', value: 'License' });
    expect(spec.conditions[1].conditions[0]).toMatchObject({ op: 'eq', value: 'Bram de Groot', checked: true });
  });

  it('never looks up a person on the change entity\'s own name, only through its account', async () => {
    // AssignmentChanges has a displayName too (the account's, denormalised);
    // it is not a Principals row, so a fragment there stays a filter.
    const spec = valid({ entity: 'change', conditions: [{ field: 'displayName', op: 'contains', value: 'bram' }] });
    const query = persons([degroot]);
    expect((await resolveNamedObjects(spec, query)).confirm).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('applyChoice — a person picked for a "contains"', () => {
  const contains = () => valid({ entity: 'user', conditions: [{ field: 'displayName', op: 'contains', value: 'bram' }] });

  it('turns the fragment into exactly the chosen person', () => {
    const spec = contains();
    expect(applyChoice(spec, { path: [0], name: 'Bram de Groot', id: 'u1' })).toBe(true);
    expect(spec.conditions[0]).toEqual({ type: 'field', field: 'displayName', op: 'contains', value: 'Bram de Groot', checked: true, ...{ op: 'eq' } });
  });

  it('keeps the fragment as written for "everyone with the name", ignoring the choice\'s label', () => {
    const spec = contains();
    expect(applyChoice(spec, { path: [0], name: 'every account with “bram” in the name', keep: true })).toBe(true);
    expect(spec.conditions[0]).toEqual({ type: 'field', field: 'displayName', op: 'contains', value: 'bram', checked: true });
  });

  it('leaves a typed name as a fragment, to be looked up again', () => {
    const spec = contains();
    expect(applyChoice(spec, { path: [0], name: ' de Groot ' })).toBe(true);
    expect(spec.conditions[0]).toEqual({ type: 'field', field: 'displayName', op: 'contains', value: 'de Groot' });
  });
});
