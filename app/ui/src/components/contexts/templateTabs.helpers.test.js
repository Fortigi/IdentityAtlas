import { describe, it, expect } from 'vitest';
import { tabOf, templateTabs, kindOptions, effectiveTab, effectiveKind, rootsForTab } from './templateTabs.helpers';

const r = (id, contextCategory, targetType = 'Identity') => ({ id, contextCategory, targetType });
const ROOTS = [
  r('ou-ppl-1', 'OrganizationalUnit', 'Identity'),
  r('ou-ppl-2', 'OrganizationalUnit', 'Identity'),
  r('ou-acc', 'OrganizationalUnit', 'Principal'),
  r('app-1', 'LogicalApplication', 'Resource'),
  r('tag-1', 'Tag', 'Resource'),
];

describe('tabOf', () => {
  it('is the template, or Other for none or an unknown one', () => {
    expect(tabOf(r('a', 'Segment'))).toBe('Segment');
    expect(tabOf(r('a', null))).toBe('Other');
    expect(tabOf(r('a', 'Gadget'))).toBe('Other');
    expect(tabOf(undefined)).toBe('Other');
  });
});

describe('templateTabs', () => {
  it('lists the four templates in order with their counts, without Other when nothing is uncategorised', () => {
    expect(templateTabs(ROOTS)).toEqual([
      { key: 'OrganizationalUnit', label: 'Organisation', count: 3 },
      { key: 'LogicalApplication', label: 'Applications', count: 1 },
      { key: 'Tag', label: 'Tags', count: 1 },
      { key: 'Segment', label: 'Segments', count: 0 },
    ]);
  });

  it('adds Other, last, once a root has no template', () => {
    const tabs = templateTabs([...ROOTS, r('x', null), r('y', 'Gadget')]);
    expect(tabs.at(-1)).toEqual({ key: 'Other', label: 'Other', count: 2 });
    expect(tabs).toHaveLength(5);
  });

  it('copes with no roots at all', () => {
    expect(templateTabs(undefined).map(t => t.count)).toEqual([0, 0, 0, 0]);
  });
});

describe('kindOptions', () => {
  it('offers only the kinds that have organisation trees, ignoring other templates of the same kind', () => {
    // The tag tree holds resources, but no organisation tree does: no Resources.
    expect(kindOptions(ROOTS)).toEqual([
      { key: 'Identity', label: 'People', count: 2 },
      { key: 'Principal', label: 'Accounts', count: 1 },
    ]);
    expect(kindOptions([r('a', 'OrganizationalUnit', 'Resource')]).map(o => o.key)).toEqual(['Resource']);
    expect(kindOptions(undefined)).toEqual([]);
  });
});

describe('effectiveTab / effectiveKind', () => {
  const tabs = templateTabs([r('t', 'Tag'), r('s', 'Segment')]);

  it('keeps a chosen tab that exists, even an empty one', () => {
    expect(effectiveTab(tabs, 'OrganizationalUnit')).toBe('OrganizationalUnit');
  });

  it('falls back to the first tab with trees when nothing (or a vanished tab) is chosen', () => {
    expect(effectiveTab(tabs, null)).toBe('Tag');
    expect(effectiveTab(tabs, 'Other')).toBe('Tag');
  });

  it('falls back to Organisation when every tab is empty', () => {
    expect(effectiveTab(templateTabs([]), null)).toBe('OrganizationalUnit');
  });

  it('keeps a chosen kind while it is offered, else the first offered kind, else none', () => {
    const opts = kindOptions([r('a', 'OrganizationalUnit', 'Resource'), r('b', 'OrganizationalUnit', 'Principal')]);
    expect(effectiveKind(opts, 'Resource')).toBe('Resource');
    // People has no trees: never the landing kind, even when it was chosen before.
    expect(effectiveKind(opts, 'Identity')).toBe('Principal');
    expect(effectiveKind(opts, null)).toBe('Principal');
    expect(effectiveKind(kindOptions([]), null)).toBeNull();
  });
});

describe('rootsForTab', () => {
  it('filters Organisation by kind', () => {
    expect(rootsForTab(ROOTS, 'OrganizationalUnit', 'Identity').map(x => x.id)).toEqual(['ou-ppl-1', 'ou-ppl-2']);
    expect(rootsForTab(ROOTS, 'OrganizationalUnit', 'Principal').map(x => x.id)).toEqual(['ou-acc']);
  });

  it('ignores the kind on every other tab', () => {
    expect(rootsForTab(ROOTS, 'Tag', 'Identity').map(x => x.id)).toEqual(['tag-1']);
    expect(rootsForTab(ROOTS, 'LogicalApplication', 'Principal').map(x => x.id)).toEqual(['app-1']);
  });

  it('copes with no roots, and lists nothing in Organisation without a kind', () => {
    expect(rootsForTab(ROOTS, 'OrganizationalUnit', null)).toEqual([]);
    expect(rootsForTab(undefined, 'Tag', 'Identity')).toEqual([]);
  });
});
