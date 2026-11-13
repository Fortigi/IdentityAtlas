// @vitest-environment jsdom
// Unit tests for useDetailTabs — the app shell's dynamic detail tabs: which
// tabs are open, where a closed tab returns to, and the per-tab data cache.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHashPage } from './useHashPage';
import { useDetailTabs } from './useDetailTabs';

// The hook as the app shell wires it: fed by the real hash router, so a
// navigate() here moves the hash exactly as it does in the app.
function useShell() {
  const [page, navigate] = useHashPage();
  return { page, ...useDetailTabs(page, navigate) };
}

// jsdom fires hashchange asynchronously; dispatch it so the hook has seen the
// new page before the next step runs.
const settleHash = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

function mountAt(hash) {
  window.location.hash = hash;
  const view = renderHook(() => useShell());
  const run = (fn) => act(() => { fn(view.result.current); settleHash(); });
  const goTo = (h) => act(() => { window.location.hash = h; settleHash(); });
  return { ...view, run, goTo, tabs: () => view.result.current.detailTabs };
}

const keys = (tabs) => tabs.map(t => `${t.type}:${t.id}`);

beforeEach(() => { window.location.hash = ''; });
afterEach(() => { window.location.hash = ''; });

describe('useDetailTabs — which tabs are open', () => {
  it('starts with no tabs on a static page', () => {
    const { tabs } = mountAt('#principals');
    expect(tabs()).toEqual([]);
  });

  it('restores the tab of a bookmarked detail link, labelled with its id', () => {
    const { tabs } = mountAt('#user:u-1');
    expect(tabs()).toEqual([{ type: 'user', id: 'u-1', displayName: 'u-1' }]);
  });

  it('adds a tab when the hash moves to a detail page that is not open yet', () => {
    const { tabs, goTo } = mountAt('#principals');
    goTo('#group:g-9');
    expect(tabs()).toEqual([{ type: 'group', id: 'g-9', displayName: 'g-9' }]);
    // Coming back to it later does not open it a second time.
    goTo('#principals');
    goTo('#group:g-9');
    expect(keys(tabs())).toEqual(['group:g-9']);
  });

  it('opens a tab with its name, remembers the page it was opened from, and goes to it', () => {
    const { tabs, run } = mountAt('#identities');
    run(s => s.openDetailTab('user', 'u-1', 'Alice'));
    expect(tabs()).toEqual([{ type: 'user', id: 'u-1', displayName: 'Alice', returnPage: 'identities' }]);
    expect(window.location.hash).toBe('#user:u-1');
  });

  it('labels a tab opened without a name with its id', () => {
    const { tabs, run } = mountAt('#identities');
    run(s => s.openDetailTab('user', 'u-1'));
    expect(tabs()[0].displayName).toBe('u-1');
  });

  it('switches to an already open tab instead of opening it twice, keeping its name and origin', () => {
    const { tabs, run, goTo } = mountAt('#identities');
    run(s => s.openDetailTab('user', 'u-1', 'Alice'));
    goTo('#resources');
    run(s => s.openDetailTab('user', 'u-1', 'Someone else'));
    expect(tabs()).toEqual([{ type: 'user', id: 'u-1', displayName: 'Alice', returnPage: 'identities' }]);
    expect(window.location.hash).toBe('#user:u-1');
  });
});

describe('useDetailTabs — closing a tab', () => {
  it('returns to the page the active tab was opened from', () => {
    // 'identities' is not where a user tab falls back to, so landing there
    // shows the remembered origin was used.
    const { tabs, run } = mountAt('#identities');
    run(s => s.openDetailTab('user', 'u-1', 'Alice'));
    run(s => s.closeDetailTab('user', 'u-1'));
    expect(tabs()).toEqual([]);
    expect(window.location.hash).toBe('#identities');
  });

  it('stays on the current page when the closed tab is not the active one', () => {
    const { tabs, run, goTo } = mountAt('#identities');
    run(s => s.openDetailTab('user', 'u-1', 'Alice'));
    goTo('#resources');
    run(s => s.closeDetailTab('user', 'u-1'));
    expect(tabs()).toEqual([]);
    expect(window.location.hash).toBe('#resources');
  });

  it.each([
    ['identity', 'identities'],
    ['report', 'reports'],
    ['context', 'contexts'],
    ['user', 'matrix'],
  ])('falls back to the home page of a %s tab (%s) when the tab was opened by link', (type, home) => {
    const { tabs, run } = mountAt(`#${type}:x-1`);
    run(s => s.closeDetailTab(type, 'x-1'));
    expect(tabs()).toEqual([]);
    expect(window.location.hash).toBe(`#${home}`);
  });

  it('hands its origin to the tabs opened from it, so closing those does not reopen it', () => {
    const { tabs, run } = mountAt('#identities');
    run(s => s.openDetailTab('user', 'u-1', 'Alice'));      // from identities
    run(s => s.openDetailTab('group', 'g-1', 'Finance'));   // from the tab of Alice
    run(s => s.openDetailTab('resource', 'r-1', 'Vault'));  // from the Finance tab
    expect(tabs().map(t => t.returnPage)).toEqual(['identities', 'user:u-1', 'group:g-1']);

    // Close the middle tab while the last one is active.
    run(s => s.closeDetailTab('group', 'g-1'));
    expect(window.location.hash).toBe('#resource:r-1');
    expect(tabs().map(t => [`${t.type}:${t.id}`, t.returnPage])).toEqual([
      ['user:u-1', 'identities'],
      ['resource:r-1', 'user:u-1'], // inherited from the closed Finance tab
    ]);

    // Closing the last tab now lands on Alice, not on the closed Finance tab.
    run(s => s.closeDetailTab('resource', 'r-1'));
    expect(window.location.hash).toBe('#user:u-1');
    expect(keys(tabs())).toEqual(['user:u-1']);
  });

  it('leaves the other tabs alone when asked to close one that is not open', () => {
    const { tabs, run } = mountAt('#identities');
    run(s => s.openDetailTab('user', 'u-1', 'Alice'));
    run(s => s.closeDetailTab('user', 'nobody'));
    expect(tabs()).toEqual([{ type: 'user', id: 'u-1', displayName: 'Alice', returnPage: 'identities' }]);
    expect(window.location.hash).toBe('#user:u-1');
  });
});

describe('useDetailTabs — the data cache of a tab', () => {
  it('merges what a detail page loads, per tab', () => {
    const { result, run } = mountAt('#user:u-1');
    run(s => s.onCacheData('u-1', 'user', { core: { displayName: 'Alice' } }));
    run(s => s.onCacheData('u-1', 'user', { memberships: ['g-1'] }));
    run(s => s.onCacheData('g-1', 'group', { memberships: [] }));
    expect(result.current.detailCacheRef.current).toEqual({
      'user:u-1': { core: { displayName: 'Alice' }, memberships: ['g-1'] },
      'group:g-1': { memberships: [] },
    });
  });

  it('gives a tab opened by link its real name once the page has loaded it', () => {
    const { tabs, run } = mountAt('#user:u-1');
    run(s => s.onCacheData('u-1', 'user', { core: { displayName: 'Alice' } }));
    expect(tabs()).toEqual([{ type: 'user', id: 'u-1', displayName: 'Alice' }]);
  });

  it('drops the cache of a closed tab and keeps the others', () => {
    const { result, run } = mountAt('#identities');
    run(s => s.openDetailTab('user', 'u-1', 'Alice'));
    run(s => s.onCacheData('u-1', 'user', { memberships: ['g-1'] }));
    run(s => s.onCacheData('u-2', 'user', { memberships: ['g-2'] }));
    run(s => s.closeDetailTab('user', 'u-1'));
    expect(result.current.detailCacheRef.current).toEqual({ 'user:u-2': { memberships: ['g-2'] } });
  });
});

describe('useDetailTabs — giving a tab a new id', () => {
  const openCompare = () => {
    const shell = mountAt('#principals');
    shell.run(s => s.openDetailTab('user', 'u-9', 'Zed'));
    shell.goTo('#principals');
    shell.run(s => s.openDetailTab('compare', 'a,b', 'Compare'));
    shell.run(s => s.onCacheData('a,b', 'compare', { rows: 2 }));
    return shell;
  };

  it('renames the tab in place, keeps where it returns to, and goes to the new id', () => {
    const { tabs, run, result } = openCompare();
    run(s => s.replaceDetailTab('compare', 'a,b', 'a,b,c'));
    expect(tabs()).toEqual([
      { type: 'user', id: 'u-9', displayName: 'Zed', returnPage: 'principals' },
      { type: 'compare', id: 'a,b,c', displayName: 'a,b,c', returnPage: 'principals' },
    ]);
    expect(window.location.hash).toBe('#compare:a,b,c');
    // The old id's data no longer describes the tab.
    expect(result.current.detailCacheRef.current).toEqual({});
  });

  it.each([
    ['the same id', 'a,b'],
    ['an empty id', ''],
    ['no id', undefined],
  ])('does nothing when given %s', (_label, newId) => {
    const { tabs, run, result } = openCompare();
    const before = tabs();
    run(s => s.replaceDetailTab('compare', 'a,b', newId));
    expect(tabs()).toBe(before);
    expect(window.location.hash).toBe('#compare:a,b');
    expect(result.current.detailCacheRef.current).toEqual({ 'compare:a,b': { rows: 2 } });
  });
});
