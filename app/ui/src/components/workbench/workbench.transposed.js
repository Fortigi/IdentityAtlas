// Authorization workbench — people as columns (the matrix's orientation). Pure.
//
// With people as rows, someone holding a hundred groups means an endless
// horizontal scrollbar; the global matrix turns it round for that reason, and so
// can the workbench. The cells stay person × resource (cellKey), so selection,
// marks, the candidate, rules, impact and save are the same in both orientations;
// only the layout differs:
//
//   rows     each business role of the band — the unit's, then the proposed ones —
//            with the entitlements it contains nested under it (the matrix's
//            "business roles as foldable rows"), then the access no role in view
//            contains ("Other access"), most held first
//   columns  the people shown (filtered and sorted), one column each; what is
//            known of them sits in header rows above (PEOPLE_COLUMNS)

import { cellValues } from './workbench.columns';

/** The orientations, in the toolbar's order; people as columns is the default (the matrix's). */
export const ORIENTATIONS = Object.freeze([
  { key: 'columns', label: 'People as columns' },
  { key: 'rows', label: 'People as rows' },
]);
export const DEFAULT_ORIENTATION = 'columns';

/** The view's orientation: 'rows' when it says so, otherwise the default. Pure. */
export const orientationOf = (view) => (view?.orientation === 'rows' ? 'rows' : DEFAULT_ORIENTATION);

/**
 * The grid's rows. `roles` is the band (bandRoles: existing roles, then proposed
 * ones, each with `contains`); `columns` the access shown (threshold and find
 * applied); `columnsById` every access column the unit has. A role lists every
 * entitlement of it the unit knows — a proposed role's must show even when few
 * hold it — so the threshold and find narrow only "Other access". `folded` holds
 * the roles whose entitlements are hidden. Each row has a unique `key`; a resource
 * two roles contain is a row under each. Pure.
 */
export function transposedRows(roles, columns, columnsById, folded = new Set()) {
  const rows = [];
  const inRole = new Set();
  for (const role of roles) {
    const entitlements = [...role.contains].map(id => columnsById.get(id)).filter(c => c && !c.isRole);
    entitlements.forEach(c => inRole.add(c.id));
    rows.push({ type: 'role', key: `role:${role.id}`, role, count: entitlements.length, folded: folded.has(role.id) });
    if (!folded.has(role.id)) {
      for (const col of entitlements) rows.push({ type: 'resource', key: `${role.id}:${col.id}`, col, role });
    }
  }
  const others = columns.filter(c => !c.isRole && !inRole.has(c.id));
  if (others.length > 0 && roles.length > 0) rows.push({ type: 'others', key: 'others', count: others.length });
  for (const col of others) rows.push({ type: 'resource', key: `other:${col.id}`, col, role: null });
  return rows;
}

/** The resources in the order the rows show them, each once — the axis a Shift-click range runs along. Pure. */
export function resourceOrder(rows) {
  return [...new Set(rows.filter(r => r.type === 'resource').map(r => r.col.id))];
}

/**
 * A person's value in a narrow header cell: the first value, how many more, and
 * all of them in words for the hover. Knowledge comes strongest first (confirmed
 * before proposed), with its link for the evidence. Pure.
 */
export function compactValue(person, column) {
  const values = cellValues(person, column);
  return {
    first: values[0] ?? null,
    more: Math.max(0, values.length - 1),
    values,
    title: values.map(v => (v.state ? `${v.label} (${v.state})` : v.label)).join('\n'),
  };
}

/**
 * The header rows above the people: the attribute columns chosen, the display
 * name last — next to the cells, where the matrix puts the names. Pure.
 */
export function headerColumns(columns) {
  const name = columns.filter(c => c.type === 'name');
  return [...columns.filter(c => c.type !== 'name'), ...name];
}
