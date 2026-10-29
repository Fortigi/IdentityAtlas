// Pure helpers for the entity-detail Diff tab.
//
// diffSnapshots(before, after) compares two entity snapshots — the shape the
// /api/<kind>/:id/diff endpoint returns for "then" and "now":
//
//   { exists, deleted, attributes: { field: value }, relationships: [item] }
//   item = { key, group, label, kind, id, detail }
//
// Nothing here knows the left side is "the past": a future proposed state can
// be compared with the current one by passing it in as either side.

import { friendlyLabel, attributeLabel } from '@ui/utils/formatters';

export const EXT_PREFIX = 'ext.';

// Groups shown first, in this order; the rest follow alphabetically.
const GROUP_ORDER = ['Manager', 'Identity', 'Linked accounts', 'Business roles', 'Members', 'Contains', 'Part of'];

// Quick picks for the comparison moment.
export const DIFF_PRESETS = [
  { days: 1, label: '1 day' },
  { days: 7, label: '1 week' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

export function daysAgoIso(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

// A date picked in an <input type="date"> (YYYY-MM-DD) → start of that day,
// local time, as ISO. Returns null for an empty or invalid value.
export function dateInputToIso(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ISO → the YYYY-MM-DD an <input type="date"> shows (local time).
export function isoToDateInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function attributeDisplayLabel(key) {
  if (key.startsWith(EXT_PREFIX)) {
    const raw = key.slice(EXT_PREFIX.length);
    return attributeLabel(raw) || raw;
  }
  return friendlyLabel(key);
}

function isEmpty(v) {
  return v === null || v === undefined || v === '';
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compareStatus(beforeVal, afterVal) {
  const b = isEmpty(beforeVal), a = isEmpty(afterVal);
  if (b && a) return null;
  if (b) return 'added';
  if (a) return 'removed';
  return sameValue(beforeVal, afterVal) ? 'unchanged' : 'changed';
}

// Attributes in a stable order: core fields first, extended after, each A→Z by label.
function diffAttributes(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const rows = [];
  for (const key of keys) {
    const status = compareStatus(before?.[key], after?.[key]);
    if (!status) continue;
    rows.push({ key, label: attributeDisplayLabel(key), extended: key.startsWith(EXT_PREFIX), before: before?.[key], after: after?.[key], status });
  }
  return rows.sort((x, y) => (x.extended - y.extended) || x.label.localeCompare(y.label));
}

function groupRank(group) {
  const i = GROUP_ORDER.indexOf(group);
  return i === -1 ? GROUP_ORDER.length : i;
}

// Relationships: one row per item key, aligned left/right, grouped.
function diffRelationships(before, after) {
  const rows = new Map();
  for (const item of before || []) rows.set(item.key, { key: item.key, group: item.group, before: item, after: null });
  for (const item of after || []) {
    const row = rows.get(item.key);
    if (row) row.after = item;
    else rows.set(item.key, { key: item.key, group: item.group, before: null, after: item });
  }
  const groups = new Map();
  for (const row of rows.values()) {
    row.status = !row.before ? 'added' : !row.after ? 'removed' : 'unchanged';
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }
  const labelOf = r => (r.after || r.before).label || '';
  return [...groups.entries()]
    .sort(([a], [b]) => (groupRank(a) - groupRank(b)) || a.localeCompare(b))
    .map(([group, list]) => ({
      group,
      rows: list.sort((x, y) => labelOf(x).localeCompare(labelOf(y))),
      beforeCount: list.filter(r => r.before).length,
      afterCount: list.filter(r => r.after).length,
    }));
}

function countStatuses(rows, counts) {
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
}

export function diffSnapshots(before, after) {
  const attributes = diffAttributes(before?.attributes, after?.attributes);
  const groups = diffRelationships(before?.relationships, after?.relationships);
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  countStatuses(attributes, counts);
  for (const g of groups) countStatuses(g.rows, counts);
  return { attributes, groups, counts };
}

// Drop unchanged rows (and groups left empty) for the "Only changes" view.
export function onlyChanges(diff) {
  return {
    ...diff,
    attributes: diff.attributes.filter(r => r.status !== 'unchanged'),
    groups: diff.groups
      .map(g => ({ ...g, rows: g.rows.filter(r => r.status !== 'unchanged') }))
      .filter(g => g.rows.length > 0),
  };
}
