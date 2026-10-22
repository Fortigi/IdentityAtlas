// Context upload — turn the rows of a list into units, one per key.
//
//   planUnits(rows, mapping) → { units, errors, warnings }
//
// Pure. A unit is what becomes one context (and, with a second member kind, its
// twin in the second tree):
//   { key, name, owner, responsibles: string[], parentKey, attributes: {header: value},
//     members: { [kind]: string[] }, firstRow }
//
// Rows that share a key are ONE unit (long format: one member per row). Its name,
// owner, parent and attributes come from the first row of the key; members and
// Responsibles are gathered from every row. Two rows with one key and different
// names are an error: the key would silently merge two different things.
//
// `errors` stop an apply (an empty key, a key with two names, a parent cycle);
// `warnings` do not (a parent key that is not in the list — the unit goes under
// the root). Both are capped at MAX_MESSAGES sentences, with a count of the rest.

import { splitValues } from './profile.js';

export const MAX_MESSAGES = 20;
// The externalId of a list's root context; no row may use it as its key.
export const ROOT_KEY = '__root__';

const cell = (row, column) => (column ? String(row?.[column] ?? '').trim() : '');

function newUnit(row, mapping, index) {
  const attributes = {};
  for (const column of mapping.attributeColumns) {
    const v = cell(row, column);
    if (v !== '') attributes[column] = v;
  }
  return {
    key: cell(row, mapping.keyColumn),
    name: cell(row, mapping.nameColumn),
    owner: cell(row, mapping.ownerColumn) || null,
    responsibles: [],
    parentKey: cell(row, mapping.parentColumn) || null,
    attributes,
    members: {},
    firstRow: index + 1,
  };
}

function addValues(target, values) {
  for (const v of values) if (!target.includes(v)) target.push(v);
}

function addRowValues(unit, row, mapping) {
  addValues(unit.responsibles, splitValues(cell(row, mapping.responsibleColumn)));
  for (const m of mapping.memberColumns) {
    const raw = cell(row, m.column);
    const values = m.shape === 'long' ? (raw ? [raw] : []) : splitValues(raw);
    unit.members[m.kind] ??= [];
    addValues(unit.members[m.kind], values);
  }
}

function capped(list) {
  if (list.length <= MAX_MESSAGES) return list;
  return [...list.slice(0, MAX_MESSAGES), `… and ${list.length - MAX_MESSAGES} more.`];
}

// Units whose parent chain returns to themselves. Returns the keys on a cycle.
export function cycleKeys(units) {
  const parentOf = new Map(units.map(u => [u.key, u.parentKey]));
  const onCycle = new Set();
  for (const start of parentOf.keys()) {
    const path = [];
    let k = start;
    while (k && parentOf.has(k) && !path.includes(k)) { path.push(k); k = parentOf.get(k); }
    if (k && path.includes(k)) path.slice(path.indexOf(k)).forEach(x => onCycle.add(x));
  }
  return [...onCycle];
}

// A parent that is the unit itself or not in the list: the unit goes under the
// root, with a warning. Mutates the units' parentKey.
function resolveParents(units, warnings) {
  const keys = new Set(units.map(u => u.key));
  for (const u of units) {
    if (!u.parentKey) continue;
    if (u.parentKey === u.key || !keys.has(u.parentKey)) {
      warnings.push(`Row ${u.firstRow}: the parent "${u.parentKey}" of "${u.name}" is not in the list, so it goes directly under the root.`);
      u.parentKey = null;
    }
  }
}

export function planUnits(rows, mapping) {
  const byKey = new Map();
  const errors = [];
  const warnings = [];
  rows.forEach((row, index) => {
    const unit = newUnit(row, mapping, index);
    if (!unit.key) { errors.push(`Row ${index + 1}: the key column "${mapping.keyColumn}" is empty.`); return; }
    if (unit.key === ROOT_KEY) { errors.push(`Row ${index + 1}: "${ROOT_KEY}" is reserved and cannot be a key.`); return; }
    if (!unit.name) unit.name = unit.key;
    const existing = byKey.get(unit.key);
    if (existing && existing.name !== unit.name) {
      errors.push(`Row ${index + 1}: the key "${unit.key}" is also on row ${existing.firstRow} with another name ("${existing.name}" and "${unit.name}").`);
      return;
    }
    if (!existing) byKey.set(unit.key, unit);
    addRowValues(byKey.get(unit.key), row, mapping);
  });
  const units = [...byKey.values()];
  resolveParents(units, warnings);
  const cyclic = cycleKeys(units);
  if (cyclic.length) errors.push(`The parent column makes a loop: ${cyclic.slice(0, 5).map(k => `"${k}"`).join(', ')} are each other's parents.`);
  return { units, errors: capped(errors), warnings: capped(warnings) };
}
