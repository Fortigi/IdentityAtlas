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

// A role's entitlements as rows: those the filters show, in the grid's order —
// and, for a proposed role, also those they hide, last and marked: nothing is
// ever silently dropped from a proposal.
function roleEntitlements(role, order, columnsById) {
  const known = [...role.contains].map(id => columnsById.get(id)).filter(c => c && !c.isRole);
  const shown = known.filter(c => order.has(c.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
  const hidden = known.filter(c => !order.has(c.id));
  return { shown, hidden, rows: role.draft ? [...shown, ...hidden] : shown };
}

/**
 * The grid's rows. `roles` is the band (bandRoles: existing roles, then proposed
 * ones, each with `contains`); `columns` the access the permission filters, the
 * held-by range and find leave, in the order to show (workbench.permissions.js
 * visibleAccess); `columnsById` every column the unit has. An entitlement the
 * filters hide is not under its role either; a role whose entitlements are all
 * hidden says so (`allHidden`). A proposed role keeps them all, the hidden ones
 * marked (`hiddenByFilter`). `folded` holds the roles whose entitlements are
 * folded away. Each row has a unique `key`; a resource two roles contain is a row
 * under each. Pure.
 */
export function transposedRows(roles, columns, columnsById, folded = new Set()) {
  const order = new Map(columns.filter(c => !c.isRole).map((c, i) => [c.id, i]));
  const rows = [];
  const inRole = new Set();
  for (const role of roles) {
    const { shown, hidden, rows: under } = roleEntitlements(role, order, columnsById);
    shown.forEach(c => inRole.add(c.id));
    const allHidden = !role.draft && shown.length === 0 && hidden.length > 0;
    rows.push({ type: 'role', key: `role:${role.id}`, role, count: shown.length, hidden: hidden.length, allHidden, folded: folded.has(role.id) });
    if (folded.has(role.id)) continue;
    for (const col of under) rows.push({ type: 'resource', key: `${role.id}:${col.id}`, col, role, hiddenByFilter: !order.has(col.id) });
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

// Vertical text in a header cell: about this many pixels per character (10–11px type), plus padding.
const PX_PER_CHAR = { name: 6.2, value: 5.6 };
const ROW_LIMITS = { name: [48, 112], value: [28, 80] };
const EMPTY_ROW = 20;
const MORE_CHIP = 14;
const clampTo = ([lo, hi], px) => Math.round(Math.min(hi, Math.max(lo, px)));

/**
 * How tall a header row is: as tall as its longest value written upwards needs —
 * within limits; a longer one is cut off with "…" and shown whole on hover — and
 * one line when nobody shown has a value. So a few short job titles take little
 * room and the permission rows below stay in view. Pure.
 */
export function headerRowHeight(column, people) {
  if (column.type === 'name') {
    const longest = Math.max(0, ...people.map(p => String(p.displayName ?? '').length));
    return clampTo(ROW_LIMITS.name, longest * PX_PER_CHAR.name + 10);
  }
  const values = people.map(p => compactValue(p, column));
  if (values.every(v => v.first === null)) return EMPTY_ROW;
  // The mark (✓ / ? / !) and a space count as two characters on knowledge.
  const mark = column.type === 'knowledge' ? 2 : 0;
  const longest = Math.max(...values.map(v => (v.first ? v.first.label.length + mark : 0)));
  const chip = values.some(v => v.more > 0) ? MORE_CHIP : 0;
  return clampTo(ROW_LIMITS.value, longest * PX_PER_CHAR.value + 10 + chip);
}
