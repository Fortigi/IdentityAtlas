import { describe, it, expect } from 'vitest';
import {
  PERMISSION_COLUMNS, permissionColumnByKey, contextIndex, permissionValues, distinctPermissionValues, matchesPermission,
  applyPermissionFilters, inHeldRange, sortPermissions, permissionFilterSummary, visibleAccess, hasPermissionFilter,
} from './workbench.permissions';
import { BLANK } from './workbench.columns';

const ctx = contextIndex([
  { id: 'suite', displayName: 'ClaimsSuite', parentId: null },
  { id: 'motor', displayName: 'Motor', parentId: 'suite' },
  { id: 'default', displayName: 'Default access', parentId: null },
  // A loop in the data must not hang the label.
  { id: 'a', displayName: 'A', parentId: 'b' }, { id: 'b', displayName: 'B', parentId: 'a' },
]);
const P = (key) => permissionColumnByKey.get(key);
const col = (id, extra = {}) => ({ id, displayName: id, resourceType: 'Group', systemName: 'Dir', holders: 1, contexts: [], isRole: false, ...extra });
const read = col('Read', { resourceType: 'AppRole', systemName: 'CS', holders: 10, contexts: ['motor'] });
const site = col('Site', { holders: 1, contexts: ['default'] });
const print = col('Print', { holders: 8, systemName: null });
const ALL = [read, site, print];
const only = (values, extra = {}) => ({ values: new Set(values), contains: [], ...extra });

describe('the permission columns', () => {
  it('are the matrix\'s row cells, in its order', () => {
    expect(PERMISSION_COLUMNS.map(c => c.label)).toEqual(['Resource name', 'Contexts', 'Type', 'System', 'Held by']);
  });
});

describe('contexts', () => {
  it('names a context by its path and takes its parents in', () => {
    expect(ctx.label('motor')).toBe('ClaimsSuite › Motor');
    expect(ctx.label('nope')).toBe('nope');
    expect(ctx.withAncestors(['motor', 'default'])).toEqual(['suite', 'motor', 'default']);
    expect(ctx.withAncestors(undefined)).toEqual([]);
    expect(ctx.label('a')).toBe('B › A');
  });

  it('a resource in a module is also in its application', () => {
    expect(permissionValues(read, P('contexts'), ctx).map(v => v.label)).toEqual(['ClaimsSuite', 'ClaimsSuite › Motor']);
  });
});

describe('values and the menu\'s list', () => {
  it('reads each column\'s value, held by as text', () => {
    expect(['name', 'type', 'system', 'held'].map(k => permissionValues(read, P(k), ctx)[0].label)).toEqual(['Read', 'AppRole', 'CS', '10']);
    expect(permissionValues(print, P('system'), ctx)).toEqual([]);
  });

  it('counts each value over the permissions, numbers in order, blanks last', () => {
    expect(distinctPermissionValues(ALL, P('held'), ctx).map(v => [v.label, v.count])).toEqual([['1', 1], ['8', 1], ['10', 1]]);
    expect(distinctPermissionValues(ALL, P('contexts'), ctx).map(v => [v.label, v.count])).toEqual([
      ['ClaimsSuite', 1], ['ClaimsSuite › Motor', 1], ['Default access', 1], ['(Blanks)', 1]]);
  });
});

describe('matching a filter', () => {
  it('keeps ANY ticked value or a contains text, and blanks when ticked', () => {
    expect(matchesPermission(read, P('type'), only(['AppRole']), ctx)).toBe(true);
    expect(matchesPermission(site, P('type'), only(['AppRole']), ctx)).toBe(false);
    expect(matchesPermission(site, P('name'), only([], { contains: ['SI'] }), ctx)).toBe(true);
    expect(matchesPermission(print, P('system'), only([BLANK]), ctx)).toBe(true);
    expect(matchesPermission(print, P('system'), only(['CS']), ctx)).toBe(false);
  });

  it('hides the resources in the ticked contexts — an application takes its modules', () => {
    const hideSuite = only(['suite'], { mode: 'hide' });
    expect(matchesPermission(read, P('contexts'), hideSuite, ctx)).toBe(false);
    expect(matchesPermission(site, P('contexts'), hideSuite, ctx)).toBe(true);
    expect(matchesPermission(print, P('contexts'), hideSuite, ctx)).toBe(true);
    expect(matchesPermission(print, P('contexts'), only([BLANK], { mode: 'hide' }), ctx)).toBe(false);
    // Only these: choosing the application keeps the module's resource.
    expect(matchesPermission(read, P('contexts'), only(['suite']), ctx)).toBe(true);
  });

  it('applies every active filter, and ignores cleared ones and unknown keys', () => {
    expect(applyPermissionFilters(ALL, { type: only(['Group']), system: only(['Dir']) }, ctx)).toEqual([site]);
    expect(applyPermissionFilters(ALL, { type: null, nope: only(['x']) }, ctx)).toBe(ALL);
    expect(applyPermissionFilters(ALL, undefined, ctx)).toBe(ALL);
  });
});

describe('held by', () => {
  it('at least and, when set, at most', () => {
    expect(ALL.filter(c => inHeldRange(c, 2, null)).map(c => c.id)).toEqual(['Read', 'Print']);
    expect(ALL.filter(c => inHeldRange(c, null, 8)).map(c => c.id)).toEqual(['Site', 'Print']);
    expect(ALL.filter(c => inHeldRange(c, 2, 8)).map(c => c.id)).toEqual(['Print']);
  });
});

describe('sorting', () => {
  it('by held by as numbers, by text either way, ties as they came', () => {
    expect(sortPermissions(ALL, { key: 'held', dir: 'asc' }, ctx).map(c => c.id)).toEqual(['Site', 'Print', 'Read']);
    expect(sortPermissions(ALL, { key: 'name', dir: 'desc' }, ctx).map(c => c.id)).toEqual(['Site', 'Read', 'Print']);
    expect(sortPermissions(ALL, { key: 'system', dir: 'asc' }, ctx).map(c => c.id)).toEqual(['Print', 'Read', 'Site']);
    expect(sortPermissions(ALL, null, ctx)).toBe(ALL);
    expect(sortPermissions(ALL, { key: 'nope' }, ctx)).toBe(ALL);
  });
});

describe('in words', () => {
  it('names the active filters, a hide as hiding', () => {
    expect(permissionFilterSummary({ contexts: only(['default'], { mode: 'hide' }), type: only(['AppRole'], { contains: ['x'] }), held: null }, ALL, ctx))
      .toEqual([{ key: 'contexts', text: 'Contexts: hiding Default access' }, { key: 'type', text: 'Type: AppRole, contains “x”' }]);
  });
});

describe('what the grid shows', () => {
  const view = (extra) => ({ permissionFilters: {}, minHolders: 1, maxHolders: null, columnSearch: '', permissionSort: null, ...extra });

  it('applies the filters, the range and find, sorts, and counts what it hid — roles aside', () => {
    const out = visibleAccess([...ALL, col('Role', { isRole: true })], view({ minHolders: 2, columnSearch: 'r', permissionSort: { key: 'held', dir: 'asc' } }), ctx);
    expect(out.columns.map(c => c.id)).toEqual(['Print', 'Read']);
    expect(out).toMatchObject({ total: 3, hidden: 1 });
    expect(visibleAccess(ALL, view({ columnSearch: 'cs' }), ctx).columns.map(c => c.id)).toEqual(['Read']);
  });

  it('says when anything narrows the permissions shown', () => {
    expect(hasPermissionFilter(view())).toBe(false);
    expect(hasPermissionFilter({})).toBe(false);
    expect(hasPermissionFilter(view({ permissionFilters: { type: only(['x']) } }))).toBe(true);
    expect(hasPermissionFilter(view({ permissionFilters: { type: null } }))).toBe(false);
    expect(hasPermissionFilter(view({ maxHolders: 3 }))).toBe(true);
    expect(hasPermissionFilter(view({ minHolders: 2 }))).toBe(true);
    expect(hasPermissionFilter(view({ columnSearch: ' x ' }))).toBe(true);
  });
});
