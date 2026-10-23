// Context upload — check a mapping the wizard sends against the file's columns.
//
//   checkMapping(input, columns) → { mapping, errors: string[] }
//
// `mapping` is the normalised mapping (see guess.js for the shape) — trimmed
// names, the key defaulted to the name column, absent optional columns as null,
// arrays deduplicated. `errors` are sentences for the analyst; the mapping is
// usable only when it is empty. Every column a mapping names must be one of the
// file's: the mapping is caller input, and it picks which cells become context
// names, owners and members.

import { MEMBER_KINDS, TEMPLATES } from './guess.js';

export const MAX_LIST_NAME = 200;
export const MAX_MEMBER_COLUMNS = 20;
export const MAX_MEMBER_KINDS = 2;
const SHAPES = ['list', 'long'];
const OPTIONAL_ROLES = [['ownerColumn', 'owner'], ['responsibleColumn', 'responsible'], ['parentColumn', 'parent']];

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function columnOrNull(value, label, known, errors) {
  const v = text(value);
  if (!v) return null;
  if (!known.has(v)) { errors.push(`The ${label} column "${v}" is not in the file.`); return null; }
  return v;
}

function checkMembers(input, known, errors) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_MEMBER_COLUMNS) errors.push(`At most ${MAX_MEMBER_COLUMNS} member columns.`);
  const out = [];
  const seen = new Set();
  for (const m of list.slice(0, MAX_MEMBER_COLUMNS)) {
    const column = text(m?.column);
    if (!known.has(column)) { errors.push(`The member column "${column}" is not in the file.`); continue; }
    if (!MEMBER_KINDS.includes(m?.kind)) { errors.push(`Choose what the column "${column}" holds: people, accounts or resources.`); continue; }
    if (seen.has(column)) continue;
    seen.add(column);
    out.push({ column, kind: m.kind, shape: SHAPES.includes(m?.shape) ? m.shape : 'list' });
  }
  if (new Set(out.map(m => m.kind)).size > MAX_MEMBER_KINDS) {
    errors.push('A list can hold at most two kinds of member (one tree per kind).');
  }
  return out;
}

function checkAttributes(input, known, errors) {
  const out = [];
  for (const c of Array.isArray(input) ? input : []) {
    const column = text(c);
    if (!known.has(column)) errors.push(`The attribute column "${column}" is not in the file.`);
    else if (!out.includes(column)) out.push(column);
  }
  return out;
}

export function checkMapping(input, columns) {
  const m = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const known = new Set(columns);
  const errors = [];
  const template = TEMPLATES.includes(m.template) ? m.template : null;
  if (!template) errors.push('Choose what the list holds: organisation units or applications.');
  const listName = text(m.listName).slice(0, MAX_LIST_NAME);
  if (!listName) errors.push('Give the list a name.');
  const nameColumn = columnOrNull(m.nameColumn, 'name', known, errors);
  if (!nameColumn && !text(m.nameColumn)) errors.push('Choose the column that holds the name.');
  const keyColumn = columnOrNull(m.keyColumn, 'key', known, errors) ?? nameColumn;
  const roles = Object.fromEntries(OPTIONAL_ROLES.map(([field, label]) => [field, columnOrNull(m[field], label, known, errors)]));
  const mapping = {
    template, listName, nameColumn, keyColumn, ...roles,
    memberColumns: checkMembers(m.memberColumns, known, errors),
    attributeColumns: checkAttributes(m.attributeColumns, known, errors),
  };
  return { mapping, errors };
}
