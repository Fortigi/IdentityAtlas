// Natural-language reports (PROTOTYPE) — report-spec validation.
//
// The LLM's output is untrusted. Everything it produces passes through
// validateSpec() before it can reach the compiler: unknown entities, fields,
// relations and operators are rejected, values are coerced to the field's type,
// and enum values are snapped to the values that actually exist in the data.
// Errors are returned as plain sentences so they can be fed back to the model
// for one repair attempt.
//
// Fields are the catalog's own plus this deployment's discovered
// `extendedAttributes` fields (`ext.<rawKey>`, see extFields.js), which the caller
// hands in — validation is the same for both, so an attribute a crawler stamped
// filters, shows and groups exactly like a built-in field.
//
// Spec shape:
//   { entity, match: 'all'|'any', conditions: [Condition], columns: [string],
//     groupBy?: 'field', sort?: { field, direction }, limit? }

//   Condition = { type:'field', field, op, value? }
//             | { type:'relation', relation, quantifier:'some'|'none', match?, conditions:[field conditions] }
//             | { type:'group', match, conditions:[field or relation conditions] }
//             | { type:'compare', relation, measure, minSimilarity?, reference:{ entity, name, id? } }   (see compare.js)
//   Column    = 'field' | '<one-relation>.<field>' | '<many-relation>.count' | '<many-relation>.names'
//             | 'compare.<similarity|shared|onlyHere|onlyReference|onlyHereNames|onlyReferenceNames>'

import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE, fieldsOf } from './catalog.js';
import { contradictions } from './contradictions.js';
import {
  COMPARE_COLUMNS, DEFAULT_COMPARE_COLUMNS, MAX_COMPARES, compareConditions, validateCompare,
} from './compare.js';

// The count column of a grouped report. Not a field of any entity: it is produced
// by the grouping itself, which is why it is spelled out here and understood by
// the sort validator, the compiler and the column picker.
export const COUNT_COLUMN = 'count';
// Grouping a date puts every row in its own group, which is not a report.
export const GROUPABLE_TYPES = ['text', 'enum', 'boolean', 'number'];

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
  change: 'change', changes: 'change', event: 'change', events: 'change',
  wijziging: 'change', wijzigingen: 'change',
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
// (nlreports/sentinels.js, inside interpret()). By the time a definition gets here the sentinel is
// therefore always already gone — so one that survives means the substitution
// did not run, and the condition would silently match an account literally
// named "@me" (i.e. nothing) instead of the person asking. Failing loudly is
// the difference between "no results" and "no results, and nobody can tell you
// why". It also stops the web report builder, which has no caller at all, from
// saving a definition that would mean something different for each reader.
export const CALLER_SENTINEL = '@me';

/**
 * The records the previous answer in this chat produced.
 *
 * The same bargain as `@me`, for the other thing a chat knows and a report
 * builder does not: what "these groups" refers to. The bot replaces it with the
 * actual ids before validation (the bot hands them to interpret()), so — exactly as above —
 * one that survives to here means the substitution did not run, and the
 * condition would match a record literally named "@previous" instead of the
 * 27 groups the caller is looking at.
 */
export const PREVIOUS_SENTINEL = '@previous';

const SENTINELS = new Set([CALLER_SENTINEL, PREVIOUS_SENTINEL]);

function coerceText(fieldName, field, value, values, err) {
  const s = String(value);
  if (SENTINELS.has(s)) err(`"${fieldName}" cannot be ${s} here — this report has no chat to resolve it against`);
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

/**
 * How many values one "is one of" may carry.
 *
 * The list that matters is the one a follow-up question inherits — "of these
 * groups, which are in an access package" — so the cap is really a cap on how
 * large an answer can still be followed up on. 500 is far past anything a
 * person reads in a chat and far short of a list that makes the query
 * pathological; past it the caller is told, rather than served a report that
 * silently covers some of what they asked about.
 */
export const MAX_IN_VALUES = 500;

/** The values of an "is one of", each coerced as if it stood alone. */
function coerceList(fieldName, field, value, values, err) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) {
    err(`condition on "${fieldName}" with operator "in" needs at least one value`);
    return [];
  }
  if (list.length > MAX_IN_VALUES) {
    err(`condition on "${fieldName}" lists ${list.length} values; at most ${MAX_IN_VALUES} are allowed`);
    return [];
  }
  const coerce = has(COERCERS_BY_TYPE, field.type) ? COERCERS_BY_TYPE[field.type] : coerceText;
  return list.map(v => coerce(fieldName, field, v, values, err));
}

function coerceValue(fieldName, field, op, value, values, err) {
  if (!OPERATORS[op].needsValue) return undefined;
  if (value === undefined || value === null || value === '') {
    err(`condition on "${fieldName}" with operator "${op}" needs a value`);
    return undefined;
  }
  if (op === 'in') return coerceList(fieldName, field, value, values, err);
  if (DAY_OPERATORS.has(op)) return coerceDays(fieldName, op, value, err);
  const coerce = has(COERCERS_BY_TYPE, field.type) ? COERCERS_BY_TYPE[field.type] : coerceText;
  return coerce(fieldName, field, value, values, err);
}

function validateFieldCondition(entityName, c, ctx, err) {
  const entity = ENTITIES[entityName];
  const fields = fieldsOf(entityName, ctx.extFields);
  const field = has(fields, c.field) ? fields[c.field] : null;
  if (!field && isImpliedType(entity, c)) {
    if (c.op === 'eq' && String(c.value).toLowerCase() === entity.implicit.value.toLowerCase()) return null;
    err(`the ${entityName} entity only contains ${entity.implicit.field} ${entity.implicit.value}; use the ${entityName === 'user' ? 'account' : 'resource'} entity for other types`);
    return null;
  }
  if (!field) {
    // Only the catalog's own fields are listed back: a deployment can have
    // hundreds of discovered ones, and this message is fed to the model to repair
    // its answer. The attributes it may use were named in the question's own
    // prompt block (extFields.js).
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
  const value = coerceValue(c.field, field, c.op, c.value, ctx.values, err);

  if (value !== undefined) out.value = value;
  return out;
}

function normalizeMatch(m) {
  return m === 'any' ? 'any' : 'all';
}

function validateConditionList(entityName, list, ctx, err, depth) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) { err('conditions must be a list'); return []; }
  return list.map(c => validateCondition(entityName, c, ctx, err, depth)).filter(Boolean);
}

function validateRelationCondition(entityName, c, ctx, err, depth) {

  const entity = ENTITIES[entityName];
  const rel = has(entity.relations, c.relation) ? entity.relations[c.relation] : null;
  if (!rel) {
    err(`"${c.relation}" is not a relation of ${entityName}. Relations: ${Object.keys(entity.relations).join(', ')}`);
    return null;
  }
  if (depth > 0) { err('a relation condition cannot be nested inside another relation'); return null; }
  const inner = validateConditionList(rel.target, c.conditions, ctx, err, depth + 1)

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

function validateCompareCondition(entityName, c, ctx, err, depth) {

  if (depth > 0) { err('a compare condition cannot be nested inside a relation'); return null; }
  return validateCompare(entityName, c, err, aliasOf);
}

function validateGroupCondition(entityName, c, ctx, err, depth) {
  if (depth > 0) { err('groups cannot be nested'); return null; }
  const inner = (Array.isArray(c.conditions) ? c.conditions : [])
    .map(ic => {
      if (inferType(ic) === 'group') { err('groups cannot be nested'); return null; }
      return validateCondition(entityName, ic, ctx, err, 0);
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

function validateCondition(entityName, c, ctx, err, depth) {
  if (!c || typeof c !== 'object') { err('each condition must be an object'); return null; }
  const type = inferType(c);
  if (!has(CONDITION_VALIDATORS, type)) {
    err(`unknown condition type "${type}"`);
    return null;
  }
  return CONDITION_VALIDATORS[type](entityName, c, ctx, err, depth);
}


/** Resolve a column reference to { key, label, kind, ... } or null. */
export function resolveColumn(entityName, ref, extFields) {
  const entity = ENTITIES[entityName];
  const fields = fieldsOf(entityName, extFields);
  if (typeof ref !== 'string') return null;
  if (has(fields, ref)) {
    const field = fields[ref];
    // `discovered` travels with the column so the picker can keep this
    // deployment's own attributes out of the way of the catalog's fields.
    return { key: ref, label: field.label, kind: 'field', field: ref, ...(field.discovered ? { discovered: true } : {}) };
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
export function availableColumns(entityName, extFields) {
  const entity = ENTITIES[entityName];
  const refs = [...Object.keys(fieldsOf(entityName, extFields))];

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
  return refs.map(r => resolveColumn(entityName, r, extFields));
}

/** Every field an entity can be grouped on — drives the "group by" picker. */
export function groupableFields(entityName, extFields) {
  return Object.entries(fieldsOf(entityName, extFields))
    .filter(([, f]) => GROUPABLE_TYPES.includes(f.type))
    .map(([name, f]) => ({ name, label: f.label, ...(f.discovered ? { discovered: true } : {}) }));
}


// The requested columns, deduplicated; falls back to the entity's defaults and
// adds the comparison columns when the report compares but asked for none.
function isSkippedColumn(entity, ref, comparing) {
  if (entity.implicit && ref === entity.implicit.field) return true;
  // Comparison columns only mean something when the report compares.
  return typeof ref === 'string' && ref.startsWith('compare.') && !comparing;
}

function validateColumns(entityName, rawColumns, comparing, extFields, err) {
  const entity = ENTITIES[entityName];
  let columns = [];
  const seen = new Set();
  for (const ref of Array.isArray(rawColumns) ? rawColumns : []) {
    if (isSkippedColumn(entity, ref, comparing)) continue;
    const colDef = resolveColumn(entityName, ref, extFields);

    if (!colDef) { err(`"${ref}" is not a valid column for ${entityName}`); continue; }
    if (!seen.has(colDef.key)) { seen.add(colDef.key); columns.push(colDef.key); }
  }
  if (columns.length === 0) columns = [...entity.defaultColumns];
  if (comparing && !columns.some(c => c.startsWith('compare.'))) columns.push(...DEFAULT_COMPARE_COLUMNS);
  if (columns.length > MAX_COLUMNS) { err(`at most ${MAX_COLUMNS} columns`); columns = columns.slice(0, MAX_COLUMNS); }
  return columns;
}

function validateSort(entityName, rawSort, groupBy, extFields, err) {
  if (!rawSort || !rawSort.field) return undefined;
  const direction = rawSort.direction === 'desc' ? 'desc' : 'asc';
  // A grouped report has two columns and neither is a plain field of the entity:
  // the value grouped on, and the count the grouping produced.
  if (groupBy) {
    if (rawSort.field !== groupBy && rawSort.field !== COUNT_COLUMN) {
      err(`a grouped report can only be sorted on "${groupBy}" or "${COUNT_COLUMN}"`);
      return undefined;
    }
    return { field: rawSort.field, direction };
  }
  if (!has(fieldsOf(entityName, extFields), rawSort.field)) {
    err(`cannot sort on "${rawSort.field}"`);
    return undefined;
  }
  return { field: rawSort.field, direction };
}

/**
 * "How many users per department" — one row per distinct value of ONE field, with
 * the number of rows that hold it. Rejected for anything that would produce a
 * group per row (a date) or that has nothing to count (a comparison, whose
 * columns describe one row against one reference).
 * @returns {string|undefined} the field name to group on
 */
function validateGroupBy(entityName, raw, comparing, extFields, err) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') { err('groupBy must be the name of a field'); return undefined; }
  const fields = fieldsOf(entityName, extFields);
  if (!has(fields, raw)) {
    err(`"${raw}" is not a field of ${entityName}, so a report cannot be grouped on it`);
    return undefined;
  }
  const field = fields[raw];
  if (!GROUPABLE_TYPES.includes(field.type)) {
    err(`"${raw}" holds a ${field.type}, which would put nearly every row in a group of its own. Group on a text, enum, number or true/false field.`);
    return undefined;
  }
  if (comparing) { err('a report that compares sets cannot also be grouped'); return undefined; }
  return raw;
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
 * @param {object} extFields  this deployment's discovered fields, by entity (extFields.js)
 * @returns {{ ok: boolean, spec: object|null, errors: string[] }}
 */
export function validateSpec(raw, values = {}, extFields = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!raw || typeof raw !== 'object') return { ok: false, spec: null, errors: ['spec must be an object'] };

  const entityName = aliasOf(raw.entity);
  if (!entityName) {
    return { ok: false, spec: null, errors: [`unknown entity "${raw.entity}". Use one of: ${Object.keys(ENTITIES).join(', ')}`] };
  }
  const ctx = { values, extFields };
  const conditions = validateConditionList(entityName, raw.conditions, ctx, err, 0);
  if (conditions.length > MAX_CONDITIONS) err(`at most ${MAX_CONDITIONS} conditions`);
  const compares = compareConditions({ conditions });
  if (compares.length > MAX_COMPARES) err(`at most ${MAX_COMPARES} compare conditions`);

  const groupBy = validateGroupBy(entityName, raw.groupBy, compares.length > 0, extFields, err);
  // Columns are kept even while grouping — they are not used by a grouped report,
  // but switching grouping back off in the editor must not lose the picked ones.
  const columns = validateColumns(entityName, raw.columns, compares.length > 0, extFields, err);
  const sort = validateSort(entityName, raw.sort, groupBy, extFields, err);
  const limit = normalizeLimit(raw.limit);

  const spec = { entity: entityName, match: normalizeMatch(raw.match), conditions, columns, limit };
  if (groupBy) spec.groupBy = groupBy;
  if (sort) spec.sort = sort;

  // Last, and only once the fields are known good: a definition that cannot
  // match anything. It runs fine and returns nothing, which reads exactly like
  // a truthful answer — see contradictions.js. Reported as a validation error
  // so the existing repair round shows the model what it built.
  for (const message of contradictions(spec)) err(message);

  return { ok: errors.length === 0, spec, errors };
}

