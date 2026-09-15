// Natural-language reports (PROTOTYPE) — report-spec validation.
//
// The LLM's output is untrusted. Everything it produces passes through
// validateSpec() before it can reach the compiler: unknown entities, fields,
// relations and operators are rejected, values are coerced to the field's type,
// and enum values are snapped to the values that actually exist in the data.
// Errors are returned as plain sentences so they can be fed back to the model
// for one repair attempt.
//
// Spec shape:
//   { entity, match: 'all'|'any', conditions: [Condition], columns: [string],
//     sort?: { field, direction }, limit? }
//   Condition = { type:'field', field, op, value? }
//             | { type:'relation', relation, quantifier:'some'|'none', match?, conditions:[field conditions] }
//             | { type:'group', match, conditions:[field or relation conditions] }
//   Column    = 'field' | '<one-relation>.<field>' | '<many-relation>.count' | '<many-relation>.names'

import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE } from './catalog.js';

export const MAX_CONDITIONS = 25;
export const MAX_COLUMNS = 15;
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 5000;

const ENTITY_ALIASES = {
  user: 'user', users: 'user', people: 'user',
  group: 'group', groups: 'group',
  account: 'account', accounts: 'account', principal: 'account', principals: 'account',
  resource: 'resource', resources: 'resource',
};

// A derived entity (user, group) already implies its type. Restating it is
// harmless and dropped; asking for a different type is a real mistake.
function isImpliedType(entity, c) {
  const imp = entity.implicit;
  return imp && c.field === imp.field;
}

const has = (obj, key) => obj != null && Object.hasOwn(obj, key);

function inferType(c) {
  if (c.type) return c.type;
  if (c.relation) return 'relation';
  if (Array.isArray(c.conditions)) return 'group';
  return 'field';
}

function coerceBoolean(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'enabled', '1'].includes(s)) return true;
  if (['false', 'no', 'disabled', '0'].includes(s)) return false;
  return undefined;
}

function coerceValue(fieldName, field, op, value, values, err) {
  if (!OPERATORS[op].needsValue) return undefined;
  if (value === undefined || value === null || value === '') {
    err(`condition on "${fieldName}" with operator "${op}" needs a value`);
    return undefined;
  }
  if (op === 'withinLastDays' || op === 'olderThanDays') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 36500) err(`"${fieldName}" ${op} needs a whole number of days`);
    return n;
  }
  switch (field.type) {
    case 'boolean': {
      const b = coerceBoolean(value);
      if (b === undefined) err(`"${fieldName}" is true/false, got "${value}"`);
      return b;
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) err(`"${fieldName}" is a number, got "${value}"`);
      return n;
    }
    case 'enum': {
      const s = String(value);
      const known = field.valuesFrom ? values?.[field.valuesFrom] : null;
      if (!known || known.length === 0) return s;
      const match = known.find(k => k.toLowerCase() === s.toLowerCase());
      if (!match) err(`"${s}" is not a known value of "${fieldName}". Known values: ${known.join(', ')}`);
      return match ?? s;
    }
    default: {
      const s = String(value);
      if (s.length > 200) err(`value for "${fieldName}" is too long`);
      return s;
    }
  }
}

function validateFieldCondition(entityName, c, values, err) {
  const entity = ENTITIES[entityName];
  const field = has(entity.fields, c.field) ? entity.fields[c.field] : null;
  if (!field && isImpliedType(entity, c)) {
    if (c.op === 'eq' && String(c.value).toLowerCase() === entity.implicit.value.toLowerCase()) return null;
    err(`the ${entityName} entity only contains ${entity.implicit.field} ${entity.implicit.value}; use the ${entityName === 'user' ? 'account' : 'resource'} entity for other types`);
    return null;
  }
  if (!field) {
    err(`"${c.field}" is not a field of ${entityName}. Fields: ${Object.keys(entity.fields).join(', ')}`);
    return null;
  }
  const allowed = OPERATORS_BY_TYPE[field.type];
  if (!has(OPERATORS, c.op) || !allowed.includes(c.op)) {
    err(`operator "${c.op}" is not allowed on "${c.field}" (${field.type}). Allowed: ${allowed.join(', ')}`);
    return null;
  }
  const out = { type: 'field', field: c.field, op: c.op };
  const value = coerceValue(c.field, field, c.op, c.value, values, err);
  if (value !== undefined) out.value = value;
  return out;
}

function normalizeMatch(m) {
  return m === 'any' ? 'any' : 'all';
}

function validateConditionList(entityName, list, values, err, depth) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) { err('conditions must be a list'); return []; }
  return list.map(c => validateCondition(entityName, c, values, err, depth)).filter(Boolean);
}

function validateCondition(entityName, c, values, err, depth) {
  if (!c || typeof c !== 'object') { err('each condition must be an object'); return null; }
  const type = inferType(c);
  if (type === 'field') return validateFieldCondition(entityName, c, values, err);

  if (type === 'relation') {
    const entity = ENTITIES[entityName];
    const rel = has(entity.relations, c.relation) ? entity.relations[c.relation] : null;
    if (!rel) {
      err(`"${c.relation}" is not a relation of ${entityName}. Relations: ${Object.keys(entity.relations).join(', ')}`);
      return null;
    }
    if (depth > 0) { err('a relation condition cannot be nested inside another relation'); return null; }
    const inner = validateConditionList(rel.target, c.conditions, values, err, depth + 1)
      .filter(ic => {
        if (ic.type === 'field') return true;
        err(`conditions inside relation "${c.relation}" must be plain field conditions`);
        return false;
      });
    return {
      type: 'relation', relation: c.relation,
      quantifier: c.quantifier === 'none' ? 'none' : 'some',
      match: normalizeMatch(c.match), conditions: inner,
    };
  }

  if (type === 'group') {
    if (depth > 0) { err('groups cannot be nested'); return null; }
    const inner = (Array.isArray(c.conditions) ? c.conditions : [])
      .map(ic => {
        if (inferType(ic) === 'group') { err('groups cannot be nested'); return null; }
        return validateCondition(entityName, ic, values, err, 0);
      })
      .filter(Boolean);
    if (inner.length === 0) return null;
    return { type: 'group', match: normalizeMatch(c.match), conditions: inner };
  }

  err(`unknown condition type "${type}"`);
  return null;
}

/** Resolve a column reference to { key, label, kind, ... } or null. */
export function resolveColumn(entityName, ref) {
  const entity = ENTITIES[entityName];
  if (typeof ref !== 'string') return null;
  if (has(entity.fields, ref)) {
    return { key: ref, label: entity.fields[ref].label, kind: 'field', field: ref };
  }
  const [relName, sub, extra] = ref.split('.');
  if (extra !== undefined || !has(entity.relations, relName)) return null;
  const rel = entity.relations[relName];
  const target = ENTITIES[rel.target];
  if (rel.cardinality === 'one' && has(target.fields, sub)) {
    return { key: ref, label: `${rel.label} ${target.fields[sub].label.toLowerCase()}`, kind: 'oneRelationField', relation: relName, field: sub };
  }
  if (rel.cardinality === 'many' && (sub === 'count' || sub === 'names')) {
    return { key: ref, label: sub === 'count' ? `${rel.label} (count)` : rel.label, kind: sub === 'count' ? 'manyCount' : 'manyNames', relation: relName };
  }
  return null;
}

/** Every column a user could pick for an entity — drives the column picker. */
export function availableColumns(entityName) {
  const entity = ENTITIES[entityName];
  const refs = [...Object.keys(entity.fields)];
  for (const [name, rel] of Object.entries(entity.relations)) {
    if (rel.cardinality === 'one') {
      for (const f of ['displayName', 'email', 'accountEnabled']) {
        if (has(ENTITIES[rel.target].fields, f)) refs.push(`${name}.${f}`);
      }
    } else {
      refs.push(`${name}.names`, `${name}.count`);
    }
  }
  return refs.map(r => resolveColumn(entityName, r));
}

/**
 * Validate and normalise a spec.
 * @param {object} raw     the spec as produced by the model (or edited in the UI)
 * @param {object} values  known enum values keyed by catalog `valuesFrom`
 * @returns {{ ok: boolean, spec: object|null, errors: string[] }}
 */
export function validateSpec(raw, values = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!raw || typeof raw !== 'object') return { ok: false, spec: null, errors: ['spec must be an object'] };

  const entityName = ENTITY_ALIASES[String(raw.entity || '').toLowerCase()];
  if (!entityName) {
    return { ok: false, spec: null, errors: [`unknown entity "${raw.entity}". Use one of: ${Object.keys(ENTITIES).join(', ')}`] };
  }
  const entity = ENTITIES[entityName];

  const conditions = validateConditionList(entityName, raw.conditions, values, err, 0);
  if (conditions.length > MAX_CONDITIONS) err(`at most ${MAX_CONDITIONS} conditions`);

  let columns = [];
  const seen = new Set();
  for (const ref of Array.isArray(raw.columns) ? raw.columns : []) {
    if (entity.implicit && ref === entity.implicit.field) continue;
    const colDef = resolveColumn(entityName, ref);
    if (!colDef) { err(`"${ref}" is not a valid column for ${entityName}`); continue; }
    if (!seen.has(colDef.key)) { seen.add(colDef.key); columns.push(colDef.key); }
  }
  if (columns.length === 0) columns = [...entity.defaultColumns];
  if (columns.length > MAX_COLUMNS) { err(`at most ${MAX_COLUMNS} columns`); columns = columns.slice(0, MAX_COLUMNS); }

  let sort;
  if (raw.sort && raw.sort.field) {
    if (has(entity.fields, raw.sort.field)) {
      sort = { field: raw.sort.field, direction: raw.sort.direction === 'desc' ? 'desc' : 'asc' };
    } else {
      err(`cannot sort on "${raw.sort.field}"`);
    }
  }

  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined && raw.limit !== null) {
    const n = Number(raw.limit);
    if (Number.isInteger(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
  }

  const spec = { entity: entityName, match: normalizeMatch(raw.match), conditions, columns, limit };
  if (sort) spec.sort = sort;
  return { ok: errors.length === 0, spec, errors };
}
