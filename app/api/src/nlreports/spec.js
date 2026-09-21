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
//             | { type:'compare', relation, measure, minSimilarity?, reference:{ entity, name, id? } }   (see compare.js)
//   Column    = 'field' | '<one-relation>.<field>' | '<many-relation>.count' | '<many-relation>.names'
//             | 'compare.<similarity|shared|onlyHere|onlyReference|onlyHereNames|onlyReferenceNames>'

import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE } from './catalog.js';
import {
  COMPARE_COLUMNS, DEFAULT_COMPARE_COLUMNS, MAX_COMPARES, compareConditions, validateCompare,
} from './compare.js';

export const MAX_CONDITIONS = 25;
export const MAX_COLUMNS = 15;
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 5000;

const ENTITY_ALIASES = {
  user: 'user', users: 'user',
  identity: 'identity', identities: 'identity', person: 'identity', persons: 'identity', people: 'identity',
  group: 'group', groups: 'group',
  account: 'account', accounts: 'account', principal: 'account', principals: 'account',
  resource: 'resource', resources: 'resource',
  businessrole: 'resource', 'business role': 'resource', 'access package': 'resource',
};

// Object.hasOwn, like every other lookup here: an entity called "constructor" or
// "__proto__" would otherwise return an inherited value and throw further down
// instead of being reported as an unknown entity.
const aliasOf = (word) => {
  const key = String(word || '').toLowerCase();
  return Object.hasOwn(ENTITY_ALIASES, key) ? ENTITY_ALIASES[key] : undefined;
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
  if (c.measure || c.reference) return 'compare';
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

// Small models abbreviate enum values ("Azure RM" for "Azure RM (tenant-id)",
// "DirectoryRole" for "EntraDirectoryRole"). Accept a fragment only when it
// points at exactly one known value — an ambiguous fragment is still an error.
function uniquePartialMatch(known, s) {
  const needle = s.trim().toLowerCase();
  if (needle.length < 3) return undefined;
  const hits = known.filter(k => k.toLowerCase().includes(needle));
  return hits.length === 1 ? hits[0] : undefined;
}

const DAY_OPERATORS = new Set(['withinLastDays', 'olderThanDays']);

function coerceDays(fieldName, op, value, err) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 36500) err(`"${fieldName}" ${op} needs a whole number of days`);
  return n;
}

function coerceEnum(fieldName, field, value, values, err) {
  const s = String(value);
  const known = field.valuesFrom ? values?.[field.valuesFrom] : null;
  if (!known || known.length === 0) return s;
  const match = known.find(k => k.toLowerCase() === s.toLowerCase()) ?? uniquePartialMatch(known, s);
  if (!match) err(`"${s}" is not a known value of "${fieldName}". Known values: ${known.join(', ')}`);
  return match ?? s;
}

// The Teams bot lets the model write "@me" where the caller's own account
// belongs, and substitutes the caller's id before validation
// (teamsbot/callerSpec.js). By the time a definition gets here the sentinel is
// therefore always already gone — so one that survives means the substitution
// did not run, and the condition would silently match an account literally
// named "@me" (i.e. nothing) instead of the person asking. Failing loudly is
// the difference between "no results" and "no results, and nobody can tell you
// why". It also stops the web report builder, which has no caller at all, from
// saving a definition that would mean something different for each reader.
export const CALLER_SENTINEL = '@me';

function coerceText(fieldName, field, value, values, err) {
  const s = String(value);
  if (s === CALLER_SENTINEL) err(`"${fieldName}" cannot be ${CALLER_SENTINEL} here — no caller is known for this report`);
  if (s.length > 200) err(`value for "${fieldName}" is too long`);
  return s;
}

// One coercer per field type; any other type (text, date, …) is kept as a string.
const COERCERS_BY_TYPE = {
  boolean: (fieldName, field, value, values, err) => {
    const b = coerceBoolean(value);
    if (b === undefined) err(`"${fieldName}" is true/false, got "${value}"`);
    return b;
  },
  number: (fieldName, field, value, values, err) => {
    const n = Number(value);
    if (!Number.isFinite(n)) err(`"${fieldName}" is a number, got "${value}"`);
    return n;
  },
  enum: coerceEnum,
};

function coerceValue(fieldName, field, op, value, values, err) {
  if (!OPERATORS[op].needsValue) return undefined;
  if (value === undefined || value === null || value === '') {
    err(`condition on "${fieldName}" with operator "${op}" needs a value`);
    return undefined;
  }
  if (DAY_OPERATORS.has(op)) return coerceDays(fieldName, op, value, err);
  const coerce = has(COERCERS_BY_TYPE, field.type) ? COERCERS_BY_TYPE[field.type] : coerceText;
  return coerce(fieldName, field, value, values, err);
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
  if (c.checked === true) out.checked = true; // the analyst chose to keep a name that was not found
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

function validateRelationCondition(entityName, c, values, err, depth) {
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

function validateCompareCondition(entityName, c, values, err, depth) {
  if (depth > 0) { err('a compare condition cannot be nested inside a relation'); return null; }
  return validateCompare(entityName, c, err, aliasOf);
}

function validateGroupCondition(entityName, c, values, err, depth) {
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

const CONDITION_VALIDATORS = {
  field: validateFieldCondition,
  relation: validateRelationCondition,
  compare: validateCompareCondition,
  group: validateGroupCondition,
};

function validateCondition(entityName, c, values, err, depth) {
  if (!c || typeof c !== 'object') { err('each condition must be an object'); return null; }
  const type = inferType(c);
  if (!has(CONDITION_VALIDATORS, type)) {
    err(`unknown condition type "${type}"`);
    return null;
  }
  return CONDITION_VALIDATORS[type](entityName, c, values, err, depth);
}

/** Resolve a column reference to { key, label, kind, ... } or null. */
export function resolveColumn(entityName, ref) {
  const entity = ENTITIES[entityName];
  if (typeof ref !== 'string') return null;
  if (has(entity.fields, ref)) {
    return { key: ref, label: entity.fields[ref].label, kind: 'field', field: ref };
  }
  const [relName, sub, extra] = ref.split('.');
  if (relName === 'compare' && extra === undefined && has(COMPARE_COLUMNS, sub)) {
    return { key: ref, label: COMPARE_COLUMNS[sub].label, kind: 'compare', sub };
  }
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
  refs.push(...Object.keys(COMPARE_COLUMNS).map(s => `compare.${s}`));
  return refs.map(r => resolveColumn(entityName, r));
}

// The requested columns, deduplicated; falls back to the entity's defaults and
// adds the comparison columns when the report compares but asked for none.
function isSkippedColumn(entity, ref, comparing) {
  if (entity.implicit && ref === entity.implicit.field) return true;
  // Comparison columns only mean something when the report compares.
  return typeof ref === 'string' && ref.startsWith('compare.') && !comparing;
}

function validateColumns(entityName, rawColumns, comparing, err) {
  const entity = ENTITIES[entityName];
  let columns = [];
  const seen = new Set();
  for (const ref of Array.isArray(rawColumns) ? rawColumns : []) {
    if (isSkippedColumn(entity, ref, comparing)) continue;
    const colDef = resolveColumn(entityName, ref);
    if (!colDef) { err(`"${ref}" is not a valid column for ${entityName}`); continue; }
    if (!seen.has(colDef.key)) { seen.add(colDef.key); columns.push(colDef.key); }
  }
  if (columns.length === 0) columns = [...entity.defaultColumns];
  if (comparing && !columns.some(c => c.startsWith('compare.'))) columns.push(...DEFAULT_COMPARE_COLUMNS);
  if (columns.length > MAX_COLUMNS) { err(`at most ${MAX_COLUMNS} columns`); columns = columns.slice(0, MAX_COLUMNS); }
  return columns;
}

function validateSort(entityName, rawSort, err) {
  if (!rawSort || !rawSort.field) return undefined;
  if (!has(ENTITIES[entityName].fields, rawSort.field)) {
    err(`cannot sort on "${rawSort.field}"`);
    return undefined;
  }
  return { field: rawSort.field, direction: rawSort.direction === 'desc' ? 'desc' : 'asc' };
}

function normalizeLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null) return DEFAULT_LIMIT;
  const n = Number(rawLimit);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
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

  const entityName = aliasOf(raw.entity);
  if (!entityName) {
    return { ok: false, spec: null, errors: [`unknown entity "${raw.entity}". Use one of: ${Object.keys(ENTITIES).join(', ')}`] };
  }
  const conditions = validateConditionList(entityName, raw.conditions, values, err, 0);
  if (conditions.length > MAX_CONDITIONS) err(`at most ${MAX_CONDITIONS} conditions`);
  const compares = compareConditions({ conditions });
  if (compares.length > MAX_COMPARES) err(`at most ${MAX_COMPARES} compare conditions`);

  const columns = validateColumns(entityName, raw.columns, compares.length > 0, err);
  const sort = validateSort(entityName, raw.sort, err);
  const limit = normalizeLimit(raw.limit);

  const spec = { entity: entityName, match: normalizeMatch(raw.match), conditions, columns, limit };
  if (sort) spec.sort = sort;
  return { ok: errors.length === 0, spec, errors };
}
