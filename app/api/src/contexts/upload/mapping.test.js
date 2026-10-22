import { describe, it, expect } from 'vitest';
import { checkMapping, MAX_MEMBER_COLUMNS } from './mapping.js';

const COLUMNS = ['Naam', 'Code', 'Eigenaar', 'Leden', 'Groepen', 'Sector'];
const base = {
  template: 'OrganizationalUnit', listName: ' Klanten ', nameColumn: 'Naam',
  memberColumns: [{ column: 'Leden', kind: 'Principal', shape: 'long' }], attributeColumns: ['Sector', 'Sector'],
};

describe('checkMapping', () => {
  it('normalises a good mapping: trimmed name, key defaulted to the name, absent roles null, duplicates dropped', () => {
    const { mapping, errors } = checkMapping(base, COLUMNS);
    expect(errors).toEqual([]);
    expect(mapping).toEqual({
      template: 'OrganizationalUnit', listName: 'Klanten', nameColumn: 'Naam', keyColumn: 'Naam',
      ownerColumn: null, responsibleColumn: null, parentColumn: null,
      memberColumns: [{ column: 'Leden', kind: 'Principal', shape: 'long' }], attributeColumns: ['Sector'],
    });
  });

  it('keeps an explicit key and owner', () => {
    const { mapping } = checkMapping({ ...base, keyColumn: 'Code', ownerColumn: 'Eigenaar' }, COLUMNS);
    expect(mapping).toMatchObject({ keyColumn: 'Code', ownerColumn: 'Eigenaar' });
  });

  it.each([
    ['an unknown template', { template: 'Tag' }, /organisation units or applications/],
    ['no list name', { listName: '   ' }, /Give the list a name/],
    ['no name column', { nameColumn: '' }, /column that holds the name/],
    ['a name column not in the file', { nameColumn: 'Nope' }, /name column "Nope" is not in the file/],
    ['an owner column not in the file', { ownerColumn: 'Boss' }, /owner column "Boss"/],
    ['a member column not in the file', { memberColumns: [{ column: 'X', kind: 'Principal' }] }, /member column "X"/],
    ['a member kind that is not one', { memberColumns: [{ column: 'Leden', kind: 'System' }] }, /people, accounts or resources/],
    ['an attribute not in the file', { attributeColumns: ['Y'] }, /attribute column "Y"/],
  ])('reports %s', (_label, change, message) => {
    const { errors } = checkMapping({ ...base, ...change }, COLUMNS);
    expect(errors.some(e => message.test(e))).toBe(true);
  });

  it('allows two kinds of member but not three', () => {
    const two = [{ column: 'Leden', kind: 'Principal' }, { column: 'Groepen', kind: 'Resource' }];
    expect(checkMapping({ ...base, memberColumns: two }, COLUMNS).errors).toEqual([]);
    const three = [...two, { column: 'Sector', kind: 'Identity' }];
    expect(checkMapping({ ...base, memberColumns: three }, COLUMNS).errors).toEqual(['A list can hold at most two kinds of member (one tree per kind).']);
  });

  it('two member columns of one kind are one tree, and an unknown shape reads as list', () => {
    const cols = [{ column: 'Leden', kind: 'Principal', shape: 'odd' }, { column: 'Groepen', kind: 'Principal' }];
    const { mapping, errors } = checkMapping({ ...base, memberColumns: cols }, COLUMNS);
    expect(errors).toEqual([]);
    expect(mapping.memberColumns.map(m => m.shape)).toEqual(['list', 'list']);
  });

  it(`caps member columns at ${MAX_MEMBER_COLUMNS}`, () => {
    const many = Array.from({ length: MAX_MEMBER_COLUMNS + 1 }, () => ({ column: 'Leden', kind: 'Principal' }));
    expect(checkMapping({ ...base, memberColumns: many }, COLUMNS).errors).toContain(`At most ${MAX_MEMBER_COLUMNS} member columns.`);
  });

  it('a non-object mapping is all errors, not a crash', () => {
    expect(checkMapping(null, COLUMNS).errors.length).toBeGreaterThanOrEqual(3);
    expect(checkMapping([], COLUMNS).mapping.template).toBeNull();
  });
});
