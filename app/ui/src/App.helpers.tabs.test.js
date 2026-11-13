import { describe, it, expect } from 'vitest';
import {
  relabelDetailTabs, isScopedContextPage, replaceTabId, parseDetailRoute, closeFallbackPage, detailTabIconBg,
} from './App.helpers';

describe('the compare tab', () => {
  it('is a detail route whose id is the comma-separated ids, closing back to the users list', () => {
    expect(parseDetailRoute('compare:a,b,c')).toEqual({ type: 'compare', id: 'a,b,c' });
    expect(closeFallbackPage('compare')).toBe('principals');
    expect(detailTabIconBg('compare')).toContain('bg-blue-100');
  });
});

describe('replaceTabId', () => {
  const tabs = [
    { type: 'compare', id: 'a,b', displayName: 'Compare: Ann · Bob', returnPage: 'principals' },
    { type: 'user', id: 'a,b', displayName: 'not a compare tab' },
  ];

  it('gives the compare tab its new id in place, keeping where it returns to, with the id as its label until named', () => {
    const next = replaceTabId(tabs, 'compare', 'a,b', 'a,b,c');
    expect(next[0]).toEqual({ type: 'compare', id: 'a,b,c', displayName: 'a,b,c', returnPage: 'principals' });
    // Same id, other type: untouched.
    expect(next[1]).toBe(tabs[1]);
  });

  it('drops the old tab when one with the new id is already open', () => {
    const open = [...tabs, { type: 'compare', id: 'b', displayName: 'Compare: Bob' }];
    expect(replaceTabId(open, 'compare', 'a,b', 'b')).toEqual([tabs[1], open[2]]);
  });
});

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
