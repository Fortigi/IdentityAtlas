import { describe, it, expect } from 'vitest';
import {
  sourceGroupOf, groupBySource, orderBySource, isEditableTree, rootKindSuffix, hasKindFilter,
  countWords, rowCount, emptyTreesCopy, editedTitle, SOURCE_OPTIONS, KIND_FILTER_OPTIONS,
} from './treePanel.helpers';

const HR = { id: 'hr', variant: 'synced', scopeSystemId: 3, scopeSystemName: 'Fortigi Demo HR' };
const AD = { id: 'ad', variant: 'synced', scopeSystemId: 4, scopeSystemName: 'Active Directory' };
const HR2 = { id: 'hr2', variant: 'synced', scopeSystemId: 3, scopeSystemName: 'Fortigi Demo HR' };
const DEPT = { id: 'dept', variant: 'generated', sourceAlgorithmName: 'department-from-principal', sourceAlgorithmDisplayName: 'Department from Principal' };
const MH = { id: 'mh', variant: 'generated', sourceAlgorithmName: 'manager-hierarchy', scopeSystemId: 9, scopeSystemName: 'Entra ID' };
const MAN = { id: 'man', variant: 'manual' };

describe('sourceGroupOf', () => {
  it('says where a tree comes from — a derived tree by the display name of the rule that made it', () => {
    expect(sourceGroupOf(HR)).toMatchObject({ key: 'synced:3', title: 'Imported', detail: 'Fortigi Demo HR' });
    expect(sourceGroupOf(DEPT)).toMatchObject({ key: 'generated:department-from-principal:', title: 'Derived', detail: 'Department from Principal' });
    expect(sourceGroupOf(MH)).toMatchObject({ key: 'hierarchy:9', title: 'Manager hierarchy', detail: 'Entra ID' });
    expect(sourceGroupOf(MAN)).toEqual({ key: 'manual', cls: 'manual', title: 'Created here', detail: null });
  });

  it('falls back to the rule\'s display name, then its name, then nothing', () => {
    expect(sourceGroupOf({ variant: 'generated', sourceAlgorithmName: 'x', sourceAlgorithmDisplayName: 'X rule' }).detail).toBe('X rule');
    expect(sourceGroupOf({ variant: 'generated', sourceAlgorithmName: 'x' }).detail).toBe('x');
    expect(sourceGroupOf({ variant: 'generated' })).toMatchObject({ key: 'generated::', detail: null });
    expect(sourceGroupOf({ variant: 'synced' })).toMatchObject({ key: 'synced:', detail: null });
  });

  it('treats an unknown variant (or none) as created here', () => {
    expect(sourceGroupOf({ variant: 'odd' }).key).toBe('manual');
    expect(sourceGroupOf(undefined).key).toBe('manual');
  });
});

describe('groupBySource / orderBySource', () => {
  it('orders imported, derived, manager hierarchy, created here — whatever order the roots arrive in', () => {
    const groups = groupBySource([MAN, MH, DEPT, HR, AD, HR2]);
    expect(groups.map(g => g.key)).toEqual(['synced:3', 'synced:4', 'generated:department-from-principal:', 'hierarchy:9', 'manual']);
    // Same system, one heading; roots keep their arrival order inside it.
    expect(groups[0].roots.map(r => r.id)).toEqual(['hr', 'hr2']);
    expect(groups[0].variant).toBe('synced');
    expect(orderBySource([MAN, MH, DEPT, HR, AD, HR2]).map(r => r.id)).toEqual(['hr', 'hr2', 'ad', 'dept', 'mh', 'man']);
  });

  it('copes with no roots', () => {
    expect(groupBySource(null)).toEqual([]);
    expect(orderBySource(undefined)).toEqual([]);
  });
});

describe('isEditableTree', () => {
  it('needs the write permission, and never an imported tree', () => {
    expect(isEditableTree('manual', true)).toBe(true);
    expect(isEditableTree('generated', true)).toBe(true);
    expect(isEditableTree('synced', true)).toBe(false);
    expect(isEditableTree('manual', false)).toBe(false);
    expect(isEditableTree('generated', undefined)).toBe(false);
  });
});

describe('rootKindSuffix / hasKindFilter', () => {
  it('names the kind only on tabs that mix kinds', () => {
    expect(rootKindSuffix('Tag', { targetType: 'Identity' })).toBe('People');
    expect(rootKindSuffix('Segment', { targetType: 'Principal' })).toBe('Accounts');
    expect(rootKindSuffix('Other', { targetType: 'System' })).toBe('Systems');
    expect(rootKindSuffix('OrganizationalUnit', { targetType: 'Identity' })).toBeNull();
    expect(rootKindSuffix('LogicalApplication', { targetType: 'Resource' })).toBeNull();
    expect(rootKindSuffix('Tag', {})).toBeNull();
    expect(hasKindFilter('Tag')).toBe(true);
    expect(hasKindFilter('OrganizationalUnit')).toBe(false);
  });
});

describe('countWords / rowCount', () => {
  it('words a count by kind, singular for one', () => {
    expect(countWords(37, 'Principal')).toBe('37 accounts');
    expect(countWords(1, 'Principal')).toBe('1 account');
    expect(countWords(1, 'Identity')).toBe('1 person');
    expect(countWords(3, 'Identity')).toBe('3 people');
    expect(countWords(0, 'Resource')).toBe('0 resources');
    expect(countWords(1, undefined)).toBe('1 member');
  });

  it('is one count — the total — with the direct share in the title only when it differs', () => {
    expect(rowCount({ targetType: 'Principal', directMemberCount: 12, totalMemberCount: 37 }))
      .toEqual({ value: 37, title: '37 accounts (12 directly in this unit)' });
    expect(rowCount({ targetType: 'Principal', directMemberCount: 5, totalMemberCount: 5 }))
      .toEqual({ value: 5, title: '5 accounts' });
    // A total that has not caught up with the direct count never shows less than is directly there.
    expect(rowCount({ targetType: 'Identity', directMemberCount: 4 })).toEqual({ value: 4, title: '4 people' });
    expect(rowCount({ targetType: 'Identity', totalMemberCount: 2 })).toEqual({ value: 2, title: '2 people (0 directly in this unit)' });
    expect(rowCount({ targetType: 'Identity' })).toBeNull();
    expect(rowCount(null)).toBeNull();
  });
});

describe('emptyTreesCopy', () => {
  it('says per kind where organisation units come from, without internal words', () => {
    expect(emptyTreesCopy('OrganizationalUnit', 'Identity')).toBe(
      'No units of people yet. Units of people come from an HR import or from the manager-hierarchy rule. Set up an import under Admin › Crawlers, or create a unit by hand.');
    expect(emptyTreesCopy('OrganizationalUnit', 'Principal')).toMatch(/^No units of accounts yet\./);
    expect(emptyTreesCopy('OrganizationalUnit', 'Resource')).toMatch(/^No units of resources yet\./);
    expect(emptyTreesCopy('OrganizationalUnit', null)).toMatch(/^No units yet\./);
  });

  it('has its own sentence per other tab, and a plain fallback', () => {
    expect(emptyTreesCopy('LogicalApplication')).toMatch(/^No applications yet\./);
    expect(emptyTreesCopy('Tag')).toMatch(/^No tags yet\./);
    expect(emptyTreesCopy('Segment')).toMatch(/^No segments yet\./);
    expect(emptyTreesCopy('Other')).toBe('Nothing here yet.');
    for (const tab of ['OrganizationalUnit', 'LogicalApplication', 'Tag', 'Segment', 'Other']) {
      expect(emptyTreesCopy(tab, 'Identity')).not.toMatch(/plugin|crawler run|synced|generated|manual|variant|principal/i);
    }
  });
});

describe('filter options and the edited title', () => {
  it('words the filters as the panel shows them', () => {
    expect(SOURCE_OPTIONS.map(o => o.label)).toEqual(['Imported', 'Derived', 'Created here']);
    expect(SOURCE_OPTIONS.map(o => o.value)).toEqual(['synced', 'generated', 'manual']);
    expect(KIND_FILTER_OPTIONS.map(o => o.label)).toEqual(['People', 'Accounts', 'Resources', 'Systems']);
  });

  it('marks a derived unit changed here, and nothing else', () => {
    expect(editedTitle({ variant: 'generated', userRenamed: true })).toBe('Changed here (renamed). Kept when the tree is refreshed.');
    expect(editedTitle({ variant: 'generated', userRenamed: true, userReparented: true })).toBe('Changed here (renamed and moved). Kept when the tree is refreshed.');
    expect(editedTitle({ variant: 'generated' })).toBeNull();
    expect(editedTitle({ variant: 'manual', userRenamed: true })).toBeNull();
    expect(editedTitle(null)).toBeNull();
  });
});
