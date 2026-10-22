import { describe, it, expect } from 'vitest';
import {
  usedColumns, withRole, toggleAttribute, addMemberColumn, updateMember, removeMember, mappingProblems,
  treesOf, aiSuggested, countsLine, membersLine, stepFooter, UPLOAD_STEPS, KIND_OPTIONS,
} from './uploadMapping.helpers';

const COLUMNS = ['Naam', 'Code', 'Eigenaar', 'Leden', 'Sector', 'Regio'];
const base = {
  template: 'OrganizationalUnit', listName: 'Klanten', nameColumn: 'Naam', keyColumn: 'Code',
  ownerColumn: null, responsibleColumn: null, parentColumn: null,
  memberColumns: [{ column: 'Leden', kind: 'Principal', shape: 'list' }], attributeColumns: ['Eigenaar', 'Sector'],
};

describe('editing the mapping', () => {
  it('usedColumns: the role and member columns, not the attributes', () => {
    expect([...usedColumns(base)].sort()).toEqual(['Code', 'Leden', 'Naam']);
  });

  it('a column chosen as a role stops being an attribute; clearing a role keeps the attributes', () => {
    const owned = withRole(base, 'ownerColumn', 'Eigenaar');
    expect(owned.ownerColumn).toBe('Eigenaar');
    expect(owned.attributeColumns).toEqual(['Sector']);
    const cleared = withRole(owned, 'ownerColumn', '');
    expect(cleared.ownerColumn).toBeNull();
    expect(cleared.attributeColumns).toEqual(['Sector']);
  });

  it('toggles an attribute on and off', () => {
    expect(toggleAttribute(base, 'Regio').attributeColumns).toEqual(['Eigenaar', 'Sector', 'Regio']);
    expect(toggleAttribute(base, 'Sector').attributeColumns).toEqual(['Eigenaar']);
  });

  it('adds a member column on the first column nothing uses, preferring one that is not an attribute', () => {
    expect(addMemberColumn(base, COLUMNS).memberColumns.at(-1)).toEqual({ column: 'Regio', kind: 'Principal', shape: 'list' });
    const allAttrs = { ...base, attributeColumns: ['Eigenaar', 'Sector', 'Regio'] };
    const next = addMemberColumn(allAttrs, COLUMNS);
    expect(next.memberColumns.at(-1).column).toBe('Eigenaar');
    expect(next.attributeColumns).toEqual(['Sector', 'Regio']);
  });

  it('adding when every column is used changes nothing', () => {
    const full = { ...base, memberColumns: [{ column: 'Leden', kind: 'Principal' }], nameColumn: 'Naam', keyColumn: 'Code' };
    expect(addMemberColumn(full, ['Naam', 'Code', 'Leden'])).toBe(full);
  });

  it('updates one member row, and a column moved into it leaves the attributes', () => {
    const next = updateMember(base, 0, { column: 'Sector', kind: 'Resource' });
    expect(next.memberColumns).toEqual([{ column: 'Sector', kind: 'Resource', shape: 'list' }]);
    expect(next.attributeColumns).toEqual(['Eigenaar']);
    expect(updateMember(base, 0, { shape: 'long' }).attributeColumns).toEqual(['Eigenaar', 'Sector']);
  });

  it('removes one member row', () => {
    const two = { ...base, memberColumns: [...base.memberColumns, { column: 'Regio', kind: 'Resource', shape: 'list' }] };
    expect(removeMember(two, 0).memberColumns).toEqual([{ column: 'Regio', kind: 'Resource', shape: 'list' }]);
  });
});

describe('mappingProblems / treesOf', () => {
  it('a good mapping has none', () => {
    expect(mappingProblems(base)).toEqual([]);
  });

  it('needs a list name and a name column, and at most two kinds', () => {
    const three = ['Principal', 'Identity', 'Resource'].map((kind, i) => ({ column: COLUMNS[i], kind }));
    expect(mappingProblems({ ...base, listName: '  ', nameColumn: null, memberColumns: three })).toEqual([
      'Give the list a name.', 'Choose the column that holds the name.', 'At most two kinds of member: each kind becomes its own tree.',
    ]);
    const two = three.slice(0, 2);
    expect(mappingProblems({ ...base, memberColumns: two })).toEqual([]);
  });

  it('one tree per kind, the second named by its kind; one tree without members', () => {
    expect(treesOf({ ...base, memberColumns: [{ kind: 'Principal' }, { kind: 'Resource' }, { kind: 'Principal' }] })).toEqual(['Klanten', 'Klanten · Resources']);
    expect(treesOf({ ...base, memberColumns: [] })).toEqual(['Klanten']);
  });

  it('kind options read as the kinds of member', () => {
    expect(KIND_OPTIONS.map(k => k.label)).toEqual(['Accounts', 'People', 'Resources']);
  });
});

describe('reading the results', () => {
  it('aiSuggested only for a listed field', () => {
    expect(aiSuggested(['keyColumn'], 'keyColumn')).toBe(true);
    expect(aiSuggested(['keyColumn'], 'nameColumn')).toBe(false);
    expect(aiSuggested(undefined, 'keyColumn')).toBe(false);
  });

  it('countsLine names removals and units not in the file only when there are some', () => {
    expect(countsLine({ created: 3, updated: 1, unchanged: 4, removed: 0, notInFile: 0 })).toBe('3 new · 1 changed · 4 unchanged');
    expect(countsLine({ created: 0, updated: 0, unchanged: 1, removed: 1, notInFile: 2 })).toBe('0 new · 0 changed · 1 unchanged · 1 removed · 2 not in this file');
    expect(countsLine(null)).toBe('');
  });

  it('membersLine names misses only when there are some', () => {
    expect(membersLine({ matched: 4, unmatched: 0, ambiguous: 0 })).toBe('4 matched');
    expect(membersLine({ matched: 4, unmatched: 1, ambiguous: 2 })).toBe('4 matched · 1 not found · 2 ambiguous');
    expect(membersLine(undefined)).toBe('');
  });
});

describe('stepFooter', () => {
  const state = { file: null, problems: [], preview: null, updating: false, reimporting: false };

  it('file step: blocked without a file; no Back on a re-import', () => {
    expect(stepFooter(UPLOAD_STEPS.file, state)).toEqual({ label: 'Read the file ▸', blocked: true, showBack: true });
    expect(stepFooter(UPLOAD_STEPS.file, { ...state, file: {}, reimporting: true })).toEqual({ label: 'Read the file ▸', blocked: false, showBack: false });
  });

  it('mapping step: blocked by one problem', () => {
    expect(stepFooter(UPLOAD_STEPS.mapping, { ...state, problems: ['x'] }).blocked).toBe(true);
    expect(stepFooter(UPLOAD_STEPS.mapping, state).blocked).toBe(false);
  });

  it('preview step: blocked without a preview or with one row error; says Update for an existing list', () => {
    expect(stepFooter(UPLOAD_STEPS.preview, state)).toEqual({ label: 'Import', blocked: true, showBack: true });
    expect(stepFooter(UPLOAD_STEPS.preview, { ...state, preview: { errors: ['bad'] } }).blocked).toBe(true);
    expect(stepFooter(UPLOAD_STEPS.preview, { ...state, preview: { errors: [] }, updating: true })).toEqual({ label: 'Update the list', blocked: false, showBack: true });
  });
});
