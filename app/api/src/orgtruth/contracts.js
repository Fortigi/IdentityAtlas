// ─── Organisation truth: the shared contracts ────────────────────────────
// Every org-truth module (import, linking, proposal, projection, the UI
// wizard) codes against the two documents defined here: the import RECIPE
// (how rows become entities and relations) and the LINK RULES (how entities
// are matched to system objects). Keep this file dependency-free: it is the
// one place the parallel workstreams must agree on.
//
// Both validators return `{ ok, errors }` where every error is a sentence a
// person (or a model, in the repair round) can act on. Nothing throws.

export const SOURCE_KINDS = ['list', 'transcript', 'email', 'manual'];
export const ORIGINS = ['import', 'model', 'analyst'];
export const CLAIM_STATUSES = ['proposed', 'accepted', 'rejected'];
export const RUN_MODES = ['full', 'delta'];

// The system fields an org entity may be matched on, per target type. These
// are real columns (001_core_schema.sql); the linking engine reads nothing
// else, so a rule can never reach into JSONB by name.
export const LINK_TARGETS = Object.freeze({
  Principal: ['email', 'employeeId', 'displayName'],
  Identity:  ['email', 'employeeId', 'displayName'],
  Resource:  ['displayName', 'mail', 'externalId'],
  Context:   ['displayName'],
  // An entity of ANOTHER organisation list (open, accepted, of a different entity
  // type): the customer named in a timesheet row ↔ the customer in the customer list.
  OrgEntity: ['displayName'],
});

// exact  — trimmed, case-insensitive equality
// prefix — the org value equals the target's email local part after stripping known prefixes
// name   — graded person-name match (accountlinking/classifier.js nameMatchLevel)
// token  — every token of the org value occurs in the target value
// fuzzy  — similarity of two names after dropping legal forms and punctuation
//          (character bigrams, or one name's words all inside the other's);
//          earns weight × similarity when the similarity is at least 0.5
export const SIGNAL_TYPES = ['exact', 'prefix', 'name', 'token', 'fuzzy'];

export const LIMITS = Object.freeze({
  entities: 20,
  relations: 40,
  attributesPerEntity: 100,
  signalsPerRule: 10,
  keyColumns: 6,
});

// The entity's own name is addressable as an attribute in link rules.
export const NAME_ATTRIBUTE = 'displayName';

// ─── JSON schema (for the model's constrained output and for the UI) ──────
export const RECIPE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'entities', 'relations'],
  properties: {
    version: { const: 1 },
    entities: {
      type: 'array', minItems: 1, maxItems: LIMITS.entities,
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'nameColumn'],
        properties: {
          type:          { type: 'string', minLength: 1, maxLength: 64 },
          nameColumn:    { type: 'string', minLength: 1, maxLength: 256 },
          keyColumn:     { type: 'string', minLength: 1, maxLength: 256 },
          nameAttribute: { type: 'string', minLength: 1, maxLength: 64 },
          keyColumns:    { type: 'array', minItems: 2, maxItems: LIMITS.keyColumns, items: { type: 'string', minLength: 1, maxLength: 256 } },
          attributes: {
            type: 'array', maxItems: LIMITS.attributesPerEntity,
            items: {
              type: 'object', additionalProperties: false, required: ['column'],
              properties: {
                column: { type: 'string', minLength: 1, maxLength: 256 },
                name:   { type: 'string', minLength: 1, maxLength: 64 },
              },
            },
          },
        },
      },
    },
    relations: {
      type: 'array', maxItems: LIMITS.relations,
      items: {
        type: 'object', additionalProperties: false,
        required: ['predicate', 'from', 'to'],
        properties: {
          predicate: { type: 'string', minLength: 1, maxLength: 64 },
          from:      { type: 'string', minLength: 1, maxLength: 64 },
          to:        { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  },
});

export const LINK_RULES_JSON_SCHEMA = Object.freeze({
  type: 'array',
  maxItems: LIMITS.entities,
  items: {
    type: 'object', additionalProperties: false,
    required: ['entityType', 'targetType', 'signals'],
    properties: {
      entityType: { type: 'string', minLength: 1, maxLength: 64 },
      targetType: { enum: Object.keys(LINK_TARGETS) },
      via:        { type: 'string', minLength: 1, maxLength: 64 },
      name:       { type: 'string', maxLength: 200 },
      targetEntityType: { type: 'string', minLength: 1, maxLength: 64 },
      threshold:  { type: 'integer', minimum: 0, maximum: 100 },
      signals: {
        type: 'array', minItems: 1, maxItems: LIMITS.signalsPerRule,
        items: {
          type: 'object', additionalProperties: false,
          required: ['attribute', 'targetField', 'type', 'weight'],
          properties: {
            name:        { type: 'string', maxLength: 64 },
            attribute:   { type: 'string', minLength: 1, maxLength: 64 },
            targetField: { type: 'string', minLength: 1, maxLength: 64 },
            type:        { enum: SIGNAL_TYPES },
            weight:      { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Attribute names an entity definition exposes to link rules and to the UI:
// its own name (also under `nameAttribute` when the analyst named it) plus
// every mapped column (attribute `name` defaults to the column header).
export function entityAttributeNames(entityDef) {
  const names = [NAME_ATTRIBUTE];
  const alias = entityDef?.nameAttribute;
  if (isNonEmptyString(alias) && alias.trim() !== NAME_ATTRIBUTE) names.push(alias.trim());
  for (const a of entityDef?.attributes ?? []) {
    const n = isNonEmptyString(a?.name) ? a.name.trim() : a?.column;
    if (isNonEmptyString(n) && !names.includes(n)) names.push(n);
  }
  return names;
}

// ─── validateRecipe ──────────────────────────────────────────────────────
// Each check is its own small function that pushes sentences into `errors`;
// the entry points only sequence them (complexity gate: ≤ 15 cognitive).
const isWholeNumberIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function columnChecker(columns, errors) {
  const known = new Set(columns ?? []);
  return (col, where) => {
    if (columns && !known.has(col)) errors.push(`${where} refers to column "${col}", which the source does not have.`);
  };
}

function checkEntityColumns(e, type, checkColumn, errors) {
  if (!isNonEmptyString(e.nameColumn)) errors.push(`Entity "${type}" has no "nameColumn".`);
  else checkColumn(e.nameColumn, `Entity "${type}" nameColumn`);
  if (e.nameAttribute !== undefined && !isNonEmptyString(e.nameAttribute)) errors.push(`Entity "${type}" has an empty "nameAttribute".`);
  checkKeyColumns(e, type, checkColumn, errors);
  if (e.keyColumn === undefined) return;
  if (!isNonEmptyString(e.keyColumn)) errors.push(`Entity "${type}" has an empty "keyColumn".`);
  else checkColumn(e.keyColumn, `Entity "${type}" keyColumn`);
}

// A composite key: several columns that together identify a row (a timesheet:
// year + month + person + customer). Takes precedence over keyColumn.
function checkKeyColumns(e, type, checkColumn, errors) {
  if (e.keyColumns === undefined) return;
  const ok = Array.isArray(e.keyColumns) && e.keyColumns.length >= 2 && e.keyColumns.length <= LIMITS.keyColumns
    && e.keyColumns.every(isNonEmptyString);
  if (!ok) { errors.push(`Entity "${type}" "keyColumns" must list 2 to ${LIMITS.keyColumns} column names.`); return; }
  for (const c of e.keyColumns) checkColumn(c, `Entity "${type}" keyColumns`);
}

function checkEntityAttributes(attrs, type, checkColumn, errors, nameAttribute) {
  if (!Array.isArray(attrs)) { errors.push(`Entity "${type}" "attributes" must be an array.`); return; }
  if (attrs.length > LIMITS.attributesPerEntity) errors.push(`Entity "${type}" has ${attrs.length} attributes; the maximum is ${LIMITS.attributesPerEntity}.`);
  const seen = new Set([NAME_ATTRIBUTE, ...(isNonEmptyString(nameAttribute) ? [nameAttribute.trim()] : [])]);
  for (const a of attrs) {
    if (!isNonEmptyString(a?.column)) { errors.push(`Entity "${type}" has an attribute without a "column".`); continue; }
    checkColumn(a.column, `Entity "${type}" attribute`);
    const name = isNonEmptyString(a.name) ? a.name.trim() : a.column;
    if (seen.has(name)) errors.push(`Entity "${type}" maps attribute "${name}" twice.`);
    seen.add(name);
  }
}

// Returns the set of defined entity types.
function checkEntities(entities, checkColumn, errors) {
  const types = new Set();
  if (!entities || entities.length === 0) errors.push('The recipe needs at least one entity.');
  else if (entities.length > LIMITS.entities) errors.push(`The recipe has ${entities.length} entities; the maximum is ${LIMITS.entities}.`);
  for (const [i, e] of (entities ?? []).entries()) {
    if (!isNonEmptyString(e?.type)) { errors.push(`Entity ${i + 1} has no "type".`); continue; }
    const type = e.type.trim();
    if (types.has(type)) errors.push(`Entity type "${type}" is defined more than once.`);
    types.add(type);
    checkEntityColumns(e, type, checkColumn, errors);
    checkEntityAttributes(e.attributes ?? [], type, checkColumn, errors, e.nameAttribute);
  }
  return types;
}

function checkRelationSides(r, where, types, errors) {
  for (const side of ['from', 'to']) {
    if (!isNonEmptyString(r?.[side])) errors.push(`${where} has no "${side}" entity type.`);
    else if (!types.has(r[side].trim())) errors.push(`${where} refers to entity type "${r[side]}", which the recipe does not define.`);
  }
}

function checkRelations(relations, types, errors) {
  if (!Array.isArray(relations)) { errors.push('The recipe "relations" must be an array.'); return; }
  if (relations.length > LIMITS.relations) errors.push(`The recipe has ${relations.length} relations; the maximum is ${LIMITS.relations}.`);
  const seen = new Set();
  for (const [i, r] of relations.entries()) {
    const where = `Relation ${i + 1}`;
    if (!isNonEmptyString(r?.predicate)) errors.push(`${where} has no "predicate".`);
    checkRelationSides(r, where, types, errors);
    const key = `${r?.predicate}|${r?.from}|${r?.to}`;
    if (seen.has(key)) errors.push(`${where} (${r.predicate}: ${r.from} → ${r.to}) is defined more than once.`);
    seen.add(key);
  }
}

export function validateRecipe(recipe, columns = null) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return { ok: false, errors: ['The recipe must be an object with "entities" and "relations".'] };
  }
  const errors = [];
  if (recipe.version !== 1) errors.push('The recipe "version" must be 1.');
  const checkColumn = columnChecker(columns, errors);
  const types = checkEntities(Array.isArray(recipe.entities) ? recipe.entities : null, checkColumn, errors);
  checkRelations(recipe.relations ?? [], types, errors);
  return { ok: errors.length === 0, errors };
}

// ─── validateLinkRules ───────────────────────────────────────────────────
function checkSignal(s, sw, { fields, targetType, allowedAttrs }, errors) {
  if (!isNonEmptyString(s?.attribute)) errors.push(`${sw} has no "attribute".`);
  else if (allowedAttrs && !allowedAttrs.includes(s.attribute)) errors.push(`${sw} uses attribute "${s.attribute}", which entity "${allowedAttrs.entityType}" does not have (have: ${allowedAttrs.join(', ')}).`);
  if (!fields.includes(s?.targetField)) errors.push(`${sw} targets field "${s?.targetField}"; ${targetType} allows ${fields.join(', ')}.`);
  if (!SIGNAL_TYPES.includes(s?.type)) errors.push(`${sw} has type "${s?.type}"; use one of ${SIGNAL_TYPES.join(', ')}.`);
  if (!isWholeNumberIn(s?.weight, 1, 100)) errors.push(`${sw} weight must be a whole number from 1 to 100.`);
}

function checkSignals(rule, where, et, entityDef, fields, errors) {
  if (!Array.isArray(rule.signals) || rule.signals.length === 0) { errors.push(`${where} ("${et}") needs at least one signal.`); return; }
  if (rule.signals.length > LIMITS.signalsPerRule) errors.push(`${where} ("${et}") has ${rule.signals.length} signals; the maximum is ${LIMITS.signalsPerRule}.`);
  let allowedAttrs = null;
  if (entityDef) { allowedAttrs = entityAttributeNames(entityDef); allowedAttrs.entityType = et; }
  for (const [j, s] of rule.signals.entries()) {
    checkSignal(s, `${where} ("${et}") signal ${j + 1}`, { fields, targetType: rule.targetType, allowedAttrs }, errors);
  }
}

// The attribute a rule links THROUGH: given, else the first signal's attribute,
// else the entity's own name. One link per value of it (a cell listing several
// people yields several links); a rule is identified by (entityType, targetType, via).
export function ruleVia(rule) {
  if (isNonEmptyString(rule?.via)) return rule.via.trim();
  const first = rule?.signals?.[0]?.attribute;
  return isNonEmptyString(first) ? first : NAME_ATTRIBUTE;
}

// A rule to another list names that list's entity type when it has one ("Uren → FortigiTeam via klant").
const ruleTarget = (rule) => (rule.targetType === 'OrgEntity' && isNonEmptyString(rule.targetEntityType) ? rule.targetEntityType.trim() : rule.targetType);
export const ruleName = (rule) => `${rule.entityType.trim()} → ${ruleTarget(rule)} via ${ruleVia(rule)}`;

function checkRule(rule, where, et, entityDefs, recipe, errors) {
  if (recipe && !entityDefs.has(et)) errors.push(`${where} is for entity type "${et}", which the recipe does not define.`);
  const fields = LINK_TARGETS[rule.targetType];
  if (!fields) { errors.push(`${where} ("${et}") has an unknown targetType "${rule.targetType}"; use one of ${Object.keys(LINK_TARGETS).join(', ')}.`); return; }
  if (rule.threshold !== undefined && !isWholeNumberIn(rule.threshold, 0, 100)) errors.push(`${where} ("${et}") threshold must be a whole number from 0 to 100.`);
  if (rule.via !== undefined && !isNonEmptyString(rule.via)) errors.push(`${where} ("${et}") has an empty "via".`);
  if (rule.targetEntityType !== undefined && (rule.targetType !== 'OrgEntity' || !isNonEmptyString(rule.targetEntityType))) {
    errors.push(`${where} ("${et}") targetEntityType names the entity type of another list and only goes with targetType OrgEntity.`);
  }
  const entityDef = recipe ? entityDefs.get(et) : null;
  if (entityDef && isNonEmptyString(rule.via) && !entityAttributeNames(entityDef).includes(rule.via.trim())) {
    errors.push(`${where} ("${et}") links via "${rule.via}", which entity "${et}" does not have (have: ${entityAttributeNames(entityDef).join(', ')}).`);
  }
  checkSignals(rule, where, et, entityDef, fields, errors);
}

export function validateLinkRules(rules, recipe = null) {
  if (!Array.isArray(rules)) return { ok: false, errors: ['Link rules must be an array.'] };
  const errors = [];
  const entityDefs = new Map((recipe?.entities ?? []).map(e => [e?.type?.trim?.(), e]));
  const seen = new Set();
  for (const [i, rule] of rules.entries()) {
    const where = `Link rule ${i + 1}`;
    if (!isNonEmptyString(rule?.entityType)) { errors.push(`${where} has no "entityType".`); continue; }
    const et = rule.entityType.trim();
    const key = `${et}|${rule.targetType}|${ruleVia(rule)}`;
    if (seen.has(key)) errors.push(`${where} repeats ${et} → ${rule.targetType} via ${ruleVia(rule)}; one rule per attribute and target type.`);
    seen.add(key);
    checkRule(rule, where, et, entityDefs, recipe, errors);
  }
  return { ok: errors.length === 0, errors };
}

// Fill in the defaults every consumer may rely on after validation passed.
export function normalizeRecipe(recipe) {
  return {
    version: 1,
    entities: recipe.entities.map(e => ({
      type: e.type.trim(),
      nameColumn: e.nameColumn,
      keyColumn: e.keyColumn ?? e.nameColumn,
      ...(Array.isArray(e.keyColumns) && e.keyColumns.length >= 2 ? { keyColumns: [...e.keyColumns] } : {}),
      ...(isNonEmptyString(e.nameAttribute) && e.nameAttribute.trim() !== NAME_ATTRIBUTE ? { nameAttribute: e.nameAttribute.trim() } : {}),
      attributes: (e.attributes ?? []).map(a => ({ column: a.column, name: isNonEmptyString(a.name) ? a.name.trim() : a.column })),
    })),
    relations: (recipe.relations ?? []).map(r => ({ predicate: r.predicate.trim(), from: r.from.trim(), to: r.to.trim() })),
  };
}

export function normalizeLinkRules(rules) {
  return rules.map(r => ({
    entityType: r.entityType.trim(),
    targetType: r.targetType,
    via: ruleVia(r),
    name: isNonEmptyString(r.name) ? r.name.trim() : ruleName(r),
    ...(isNonEmptyString(r.targetEntityType) ? { targetEntityType: r.targetEntityType.trim() } : {}),
    threshold: r.threshold ?? 50,
    signals: r.signals.map((s, i) => ({
      name: isNonEmptyString(s.name) ? s.name.trim() : `${s.attribute}→${s.targetField}`,
      attribute: s.attribute, targetField: s.targetField, type: s.type, weight: s.weight,
      order: i,
    })),
  }));
}
