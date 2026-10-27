// Authorization workbench — filtering the permissions shown, the way the people
// are filtered (workbench.columns.js): an Excel-like filter per column, AND
// across columns. Pure.
//
//   PERMISSION_COLUMNS                  Resource name, Contexts, Type, System, Held by
//   permissionValues(col, pcol, ctx)    one access column's values in a permission column
//   distinctPermissionValues(...)       the filter menu's list: each value with how many permissions have it
//   applyPermissionFilters(...)         the access columns passing every filter and the held-by range
//   sortPermissions(cols, sort, ctx)    the access columns in a permission column's order
//
// Contexts (the tags and logical applications a resource belongs to, the matrix's
// Contexts cell) work both ways: "only these" or "hide resources in these" — and a
// context takes its sub-contexts, so choosing a logical application takes the
// resources in its modules too. `ctx` is contextIndex(data.contexts).

import { BLANK } from './workbench.columns';

export const PERMISSION_COLUMNS = Object.freeze([
  { key: 'name', label: 'Resource name', type: 'text' },
  { key: 'contexts', label: 'Contexts', type: 'context' },
  { key: 'type', label: 'Type', type: 'text' },
  { key: 'system', label: 'System', type: 'text' },
  { key: 'held', label: 'Held by', type: 'count' },
]);
export const permissionColumnByKey = new Map(PERMISSION_COLUMNS.map(c => [c.key, c]));
export const CONTEXT_MODES = Object.freeze([{ key: 'only', label: 'Only these' }, { key: 'hide', label: 'Hide resources in these' }]);

/** { byId: Map(id → context), label(id) → "Parent › Child" } over the payload's contexts (each with its parentId). Pure. */
export function contextIndex(contexts) {
  const byId = new Map((contexts || []).map(c => [String(c.id), c]));
  const chain = (id) => {
    const out = [];
    const seen = new Set();
    for (let c = byId.get(id); c && !seen.has(c.id); c = byId.get(String(c.parentId))) { seen.add(c.id); out.unshift(c); }
    return out;
  };
  return {
    byId,
    // A context and every parent above it: a resource in a module is also "in" its application.
    withAncestors: (ids) => [...new Set((ids || []).flatMap(id => chain(String(id)).map(c => String(c.id))))],
    label: (id) => chain(String(id)).map(c => c.displayName).join(' › ') || String(id),
  };
}

const text = (v) => (v == null || v === '' ? [] : [{ value: String(v), label: String(v) }]);

/** One access column's values in one permission column. Pure. */
export function permissionValues(col, pcol, ctx) {
  switch (pcol.key) {
    case 'name': return text(col.displayName);
    case 'type': return text(col.resourceType);
    case 'system': return text(col.systemName);
    case 'held': return text(col.holders);
    default: return ctx.withAncestors(col.contexts).map(id => ({ value: id, label: ctx.label(id) }));
  }
}

/** The menu's values over these access columns, with how many have each; blanks last. Pure. */
export function distinctPermissionValues(columns, pcol, ctx) {
  const counts = new Map();
  let blanks = 0;
  for (const col of columns) {
    const vals = permissionValues(col, pcol, ctx);
    if (vals.length === 0) blanks++;
    for (const v of vals) {
      const e = counts.get(v.value) ?? { ...v, count: 0 };
      e.count++;
      counts.set(v.value, e);
    }
  }
  const out = [...counts.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (blanks > 0) out.push({ value: BLANK, label: '(Blanks)', count: blanks });
  return out;
}

/**
 * Does an access column pass one filter? "Hide" (contexts): none of its values is
 * ticked. Otherwise ANY value ticked, or containing one of the `contains` texts —
 * or blank ticked when it has none. Pure.
 */
export function matchesPermission(col, pcol, filter, ctx) {
  const vals = permissionValues(col, pcol, ctx);
  if (filter.mode === 'hide') return !vals.some(v => filter.values.has(v.value)) && !(vals.length === 0 && filter.values.has(BLANK));
  if (vals.length === 0) return filter.values.has(BLANK);
  const contains = (filter.contains || []).map(t => t.toLowerCase());
  return vals.some(v => filter.values.has(v.value) || contains.some(t => v.label.toLowerCase().includes(t)));
}

/** Held by at least `min` and — when set — at most `max` people. Pure. */
export const inHeldRange = (col, min, max) => col.holders >= (min ?? 1) && (max == null || col.holders <= max);

/** The access columns passing every permission filter (AND across columns). Pure. */
export function applyPermissionFilters(columns, filters, ctx) {
  const active = Object.entries(filters || {}).filter(([key, f]) => f && f.values && permissionColumnByKey.has(key));
  if (active.length === 0) return columns;
  return columns.filter(col => active.every(([key, f]) => matchesPermission(col, permissionColumnByKey.get(key), f, ctx)));
}

/** The access columns in one permission column's order (first value, numbers as numbers), ties as they came. Pure. */
export function sortPermissions(columns, sort, ctx) {
  const pcol = sort && permissionColumnByKey.get(sort.key);
  if (!pcol) return columns;
  const dir = sort.dir === 'desc' ? -1 : 1;
  const keyOf = (col) => (pcol.key === 'held' ? col.holders : permissionValues(col, pcol, ctx)[0]?.label ?? '');
  return [...columns].sort((a, b) => {
    const [x, y] = [keyOf(a), keyOf(b)];
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return c * dir;
  });
}

/** "Resource name: Read, Group · Contexts: hiding Default access" — the active permission filters in words. Pure. */
export function permissionFilterSummary(filters, columns, ctx) {
  return Object.entries(filters || {}).filter(([key, f]) => f && f.values && permissionColumnByKey.has(key)).map(([key, f]) => {
    const pcol = permissionColumnByKey.get(key);
    const labels = new Map(distinctPermissionValues(columns, pcol, ctx).map(v => [v.value, v.label]));
    const named = [...f.values].map(v => labels.get(v) ?? (pcol.key === 'contexts' ? ctx.label(v) : v));
    const words = [...named, ...(f.contains || []).map(t => `contains “${t}”`)].join(', ');
    return { key, text: `${pcol.label}: ${f.mode === 'hide' ? 'hiding ' : ''}${words}` };
  });
}

/**
 * The access the grid shows: every permission filter, the held-by range (at least
 * `minHolders`, at most `maxHolders`), "Find access" on name and system — then in
 * the permission sort's order. `total` and `hidden` count the access columns
 * (business roles are rows and bands, not filtered here). Pure.
 */
export function visibleAccess(columns, view, ctx) {
  const q = (view.columnSearch || '').trim().toLowerCase();
  const found = (c) => !q || c.displayName.toLowerCase().includes(q) || (c.systemName || '').toLowerCase().includes(q);
  const access = columns.filter(c => !c.isRole);
  const shown = applyPermissionFilters(access, view.permissionFilters, ctx).filter(c => inHeldRange(c, view.minHolders, view.maxHolders) && found(c));
  return { columns: sortPermissions(shown, view.permissionSort, ctx), total: access.length, hidden: access.length - shown.length };
}

/** Does anything narrow the permissions shown — a filter, the held-by range, find? (Then the impact counts only what shows.) Pure. */
export function hasPermissionFilter(view) {
  const filtered = Object.values(view.permissionFilters || {}).some(f => f && f.values);
  return filtered || view.maxHolders != null || (view.minHolders ?? 1) > 1 || !!(view.columnSearch || '').trim();
}
