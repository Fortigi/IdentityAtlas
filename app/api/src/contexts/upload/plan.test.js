import { describe, it, expect } from 'vitest';
import { planUnits, cycleKeys, MAX_MESSAGES, ROOT_KEY } from './plan.js';

const mapping = (over = {}) => ({
  template: 'OrganizationalUnit', listName: 'Klanten', nameColumn: 'Naam', keyColumn: 'Code',
  ownerColumn: 'Eigenaar', responsibleColumn: 'Beheer', parentColumn: null,
  memberColumns: [{ column: 'Leden', kind: 'Principal', shape: 'list' }], attributeColumns: ['Sector'],
  ...over,
});

describe('planUnits — list shape', () => {
  it('makes one unit per row with owner, Responsibles, members and the non-empty attributes', () => {
    const rows = [{ Code: 'K1', Naam: 'Acme', Eigenaar: 'o@x.nl', Beheer: 'r1@x.nl; r2@x.nl', Leden: 'a@x.nl;b@x.nl', Sector: '' }];
    const { units, errors } = planUnits(rows, mapping());
    expect(errors).toEqual([]);
    expect(units).toEqual([{
      key: 'K1', name: 'Acme', owner: 'o@x.nl', responsibles: ['r1@x.nl', 'r2@x.nl'], parentKey: null,
      attributes: {}, members: { Principal: ['a@x.nl', 'b@x.nl'] }, firstRow: 1,
    }]);
  });

  it('a row without a name is named after its key', () => {
    expect(planUnits([{ Code: 'K9', Naam: '' }], mapping()).units[0].name).toBe('K9');
  });
});

describe('planUnits — long shape', () => {
  const long = mapping({ memberColumns: [{ column: 'Leden', kind: 'Principal', shape: 'long' }] });

  it('gathers one member per row under one key; other fields come from the first row', () => {
    const rows = [
      { Code: 'K1', Naam: 'Acme', Eigenaar: 'first@x.nl', Leden: 'a@x.nl', Sector: 'Zorg' },
      { Code: 'K1', Naam: 'Acme', Eigenaar: 'second@x.nl', Leden: 'b@x.nl; c@x.nl', Sector: 'Bouw' },
      { Code: 'K1', Naam: 'Acme', Eigenaar: '', Leden: 'a@x.nl', Sector: '' },
    ];
    const { units } = planUnits(rows, long);
    expect(units).toHaveLength(1);
    // Long shape takes the cell whole: one member per row, not split.
    expect(units[0].members.Principal).toEqual(['a@x.nl', 'b@x.nl; c@x.nl']);
    expect(units[0]).toMatchObject({ owner: 'first@x.nl', attributes: { Sector: 'Zorg' } });
  });

  it('two rows with one key and different names are an error naming both rows', () => {
    const { errors, units } = planUnits([{ Code: 'K1', Naam: 'Acme' }, { Code: 'K1', Naam: 'Acme BV' }], long);
    expect(errors).toEqual(['Row 2: the key "K1" is also on row 1 with another name ("Acme" and "Acme BV").']);
    expect(units).toHaveLength(1);
  });
});

describe('planUnits — keys and parents', () => {
  it('reports an empty key and the reserved root key', () => {
    const { errors } = planUnits([{ Code: '', Naam: 'A' }, { Code: ROOT_KEY, Naam: 'B' }], mapping());
    expect(errors).toEqual(['Row 1: the key column "Code" is empty.', `Row 2: "${ROOT_KEY}" is reserved and cannot be a key.`]);
  });

  it('a parent not in the list, or the unit itself, goes under the root with a warning', () => {
    const rows = [{ Code: 'A', Naam: 'A', Ouder: 'Z' }, { Code: 'B', Naam: 'B', Ouder: 'B' }, { Code: 'C', Naam: 'C', Ouder: 'A' }];
    const { units, warnings, errors } = planUnits(rows, mapping({ parentColumn: 'Ouder' }));
    expect(errors).toEqual([]);
    expect(units.map(u => u.parentKey)).toEqual([null, null, 'A']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^Row 1: the parent "Z" of "A" is not in the list/);
  });

  it('a parent loop is an error', () => {
    const rows = [{ Code: 'A', Naam: 'A', Ouder: 'B' }, { Code: 'B', Naam: 'B', Ouder: 'A' }];
    expect(planUnits(rows, mapping({ parentColumn: 'Ouder' })).errors).toEqual(['The parent column makes a loop: "A", "B" are each other\'s parents.']);
  });

  it(`caps the messages at ${MAX_MESSAGES} and counts the rest`, () => {
    const rows = Array.from({ length: MAX_MESSAGES + 3 }, () => ({ Code: '', Naam: 'x' }));
    const { errors } = planUnits(rows, mapping());
    expect(errors).toHaveLength(MAX_MESSAGES + 1);
    expect(errors.at(-1)).toBe('… and 3 more.');
  });
});

describe('cycleKeys', () => {
  it('names only the keys on the loop, not those hanging below it', () => {
    const units = [{ key: 'A', parentKey: 'B' }, { key: 'B', parentKey: 'A' }, { key: 'C', parentKey: 'A' }, { key: 'D', parentKey: null }];
    expect(cycleKeys(units).sort()).toEqual(['A', 'B']);
  });
});
