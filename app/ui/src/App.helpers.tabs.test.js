import { describe, it, expect } from 'vitest';
import { relabelDetailTabs, isScopedContextPage } from './App.helpers';

describe('relabelDetailTabs', () => {
  const tabs = [
    { type: 'context', id: 'c1', displayName: 'c1' },
    { type: 'user', id: 'u1', displayName: 'Ann' },
  ];

  it('names a tab opened by URL and records a context tab\'s template', () => {
    const next = relabelDetailTabs(tabs, 'c1', { attributes: { displayName: 'Engineering', contextCategory: 'OrganizationalUnit' } });
    expect(next[0]).toEqual({ type: 'context', id: 'c1', displayName: 'Engineering', category: 'OrganizationalUnit' });
    expect(next[1]).toBe(tabs[1]);
  });

  it('keeps a name the tab already had, and gives a non-context tab no template', () => {
    const named = [{ type: 'context', id: 'c1', displayName: 'Shown' }, { type: 'group', id: 'g1', displayName: 'g1' }];
    expect(relabelDetailTabs(named, 'c1', { attributes: { displayName: 'Other', contextCategory: 'Tag' } })[0])
      .toEqual({ type: 'context', id: 'c1', displayName: 'Shown', category: 'Tag' });
    expect(relabelDetailTabs(named, 'g1', { attributes: { displayName: 'Grp', contextCategory: 'Tag' } })[1])
      .toEqual({ type: 'group', id: 'g1', displayName: 'Grp' });
  });

  it('returns the same array when nothing changes', () => {
    const done = [{ type: 'context', id: 'c1', displayName: 'Engineering', category: 'OrganizationalUnit' }];
    expect(relabelDetailTabs(done, 'c1', { attributes: { displayName: 'Engineering', contextCategory: 'OrganizationalUnit' } })).toBe(done);
    expect(relabelDetailTabs(done, 'nope', { attributes: { displayName: 'X' } })).toBe(done);
    expect(relabelDetailTabs(done, 'c1', null)).toBe(done);
  });
});

describe('isScopedContextPage', () => {
  it('is the context page of someone who cannot edit contexts', () => {
    expect(isScopedContextPage('context:c1', false)).toBe(true);
    expect(isScopedContextPage('context:c1', true)).toBe(false);
    expect(isScopedContextPage('contexts', false)).toBe(false);
    expect(isScopedContextPage('context-builder:c1', false)).toBe(false);
    expect(isScopedContextPage(undefined, false)).toBe(false);
  });
});
