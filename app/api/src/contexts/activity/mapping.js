// Context activity — check a mapping the wizard sends against the file's columns.
//
//   checkActivityMapping(input, columns, { hasChildren }) → { mapping, errors: string[] }
//
// Same contract as the list upload's checkMapping (upload/mapping.js, whose
// column checks it reuses): `mapping` is normalised (trimmed, absent optional
// columns null, closed values defaulted), `errors` are sentences for the
// analyst and the mapping is usable only when there are none. Every column it
// names must be one of the file's — the mapping is caller input.

import { columnOrNull, checkAttributes } from '../upload/mapping.js';
import { UNITS, DATE_ORDERS } from './guess.js';

export const MAX_SOURCE_LABEL = 80;
const ROLES = [
  ['contextColumn', 'sub-unit'], ['subjectNameColumn', 'person'], ['subjectEmailColumn', 'e-mail'],
  ['dateColumn', 'date'], ['amountColumn', 'amount'], ['kindColumn', 'kind'],
];

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// One column may play one role; the second role naming it is refused.
function checkDistinct(mapping, errors) {
  const seen = new Map();
  for (const [field, label] of ROLES) {
    const column = mapping[field];
    if (!column) continue;
    if (seen.has(column)) errors.push(`The column "${column}" cannot be both the ${seen.get(column)} and the ${label}.`);
    else seen.set(column, label);
  }
}

function checkRequired(mapping, hasChildren, errors) {
  if (!mapping.sourceLabel) errors.push('Name the source of this export (for example Clockify), so a later export of it replaces this one.');
  if (!mapping.dateColumn) errors.push('Choose the column that holds the date.');
  if (!mapping.subjectNameColumn && !mapping.subjectEmailColumn) errors.push('Choose the column that names the person (a name or an e-mail address).');
  if (mapping.contextColumn && !hasChildren) errors.push('This context has no sub-units, so every row lands on it: leave the sub-unit column empty.');
}

export function checkActivityMapping(input, columns, { hasChildren = false } = {}) {
  const m = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const known = new Set(columns);
  const errors = [];
  const roles = Object.fromEntries(ROLES.map(([field, label]) => [field, columnOrNull(m[field], label, known, errors)]));
  const used = new Set(Object.values(roles).filter(Boolean));
  const mapping = {
    sourceLabel: text(m.sourceLabel).slice(0, MAX_SOURCE_LABEL),
    ...roles,
    dateOrder: DATE_ORDERS.includes(m.dateOrder) ? m.dateOrder : 'dmy',
    // Without an amount column every row is one event, whatever unit was sent.
    unit: roles.amountColumn ? (UNITS.includes(m.unit) ? m.unit : 'hours') : 'events',
    attributeColumns: checkAttributes(m.attributeColumns, known, errors).filter(c => !used.has(c)),
  };
  checkRequired(mapping, hasChildren, errors);
  checkDistinct(mapping, errors);
  return { mapping, errors };
}
