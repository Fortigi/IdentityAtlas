// ─── Organisation truth: the template-specific parts of the recipe contract ──
// contracts.js validateRecipe dispatches here on `recipe.template`:
//   enrichment  checkEnrichment — the collection checks ran already; exactly ONE
//               entity, `enrich.targetType`, attribute `multi` flags
//   activity    validateActivityRecipe — { activity: { type, actor, subject, when, measure?, attributes? } }
//   relation    validateRelationRecipe — { relation: { type, predicate, left, right, attributes? } }
// and normalizeRecipe to the normalisers below. Dependency-free like contracts.js
// (which imports this file, so it must not import contracts.js back).
//
// Every check pushes sentences a person can act on; nothing throws.

export const ENRICH_TARGETS = ['Identity', 'Principal', 'Resource'];
export const ACTOR_TARGETS = ['Principal', 'Identity'];
export const SUBJECT_TARGETS = ['OrgEntity', 'Resource'];
export const RELATION_TARGETS = ['Resource', 'Principal', 'Identity', 'OrgEntity'];
export const MAX_EXTRA_ATTRIBUTES = 50;
const MAX_NAME = 64;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const trimmed = (v) => (isNonEmptyString(v) ? v.trim() : v);

function checkName(value, what, errors) {
  if (!isNonEmptyString(value)) errors.push(`${what} is missing.`);
  else if (value.trim().length > MAX_NAME) errors.push(`${what} is longer than ${MAX_NAME} characters.`);
}

function checkColumnRef(value, what, checkColumn, errors) {
  if (!isNonEmptyString(value)) { errors.push(`${what} names no column.`); return; }
  checkColumn(value, what);
}

// ─── enrichment ──────────────────────────────────────────────────────────
export function checkEnrichment(recipe, errors) {
  if (!Array.isArray(recipe.entities) || recipe.entities.length !== 1) {
    errors.push('An enrichment describes exactly one list of things, so its recipe has exactly one entity.');
  }
  if (Array.isArray(recipe.relations) && recipe.relations.length > 0) errors.push('An enrichment has no relations between entity types.');
  const target = recipe.enrich?.targetType;
  if (!ENRICH_TARGETS.includes(target)) errors.push(`An enrichment needs "enrich.targetType": one of ${ENRICH_TARGETS.join(', ')}.`);
  for (const a of recipe.entities?.[0]?.attributes ?? []) {
    if (a?.multi !== undefined && typeof a.multi !== 'boolean') errors.push(`Attribute "${a.name ?? a.column}" "multi" must be true or false.`);
  }
}

// ─── extra attributes (activity, relation) ───────────────────────────────
function checkExtraAttributes(attrs, where, checkColumn, errors, reserved) {
  if (attrs === undefined) return;
  if (!Array.isArray(attrs)) { errors.push(`${where} "attributes" must be an array.`); return; }
  if (attrs.length > MAX_EXTRA_ATTRIBUTES) errors.push(`${where} has ${attrs.length} attributes; the maximum is ${MAX_EXTRA_ATTRIBUTES}.`);
  const seen = new Set(reserved);
  for (const a of attrs) {
    if (!isNonEmptyString(a?.column)) { errors.push(`${where} has an attribute without a "column".`); continue; }
    checkColumn(a.column, `${where} attribute`);
    const name = isNonEmptyString(a.name) ? a.name.trim() : a.column;
    if (seen.has(name)) errors.push(`${where} maps attribute "${name}" twice (or uses a reserved name).`);
    seen.add(name);
  }
}

const normalizeExtra = (attrs) => (attrs ?? []).map(a => ({ column: a.column, name: isNonEmptyString(a.name) ? a.name.trim() : a.column }));

// ─── activity ────────────────────────────────────────────────────────────
function checkActor(actor, checkColumn, errors) {
  if (!isObject(actor)) { errors.push('The activity needs an "actor": { column, targetTypes }.'); return; }
  checkColumnRef(actor.column, 'The activity actor', checkColumn, errors);
  const types = actor.targetTypes;
  const ok = Array.isArray(types) && types.length > 0 && types.every(t => ACTOR_TARGETS.includes(t)) && new Set(types).size === types.length;
  if (!ok) errors.push(`The activity actor "targetTypes" must list one or both of ${ACTOR_TARGETS.join(', ')}.`);
}

function checkTargetEntityType(side, what, errors) {
  if (side.targetEntityType === undefined) return;
  if (side.targetType !== 'OrgEntity') errors.push(`${what} "targetEntityType" only goes with targetType OrgEntity.`);
  else checkName(side.targetEntityType, `${what} "targetEntityType"`, errors);
}

function checkSubject(subject, checkColumn, errors) {
  if (!isObject(subject)) { errors.push('The activity needs a "subject": { column, targetType }.'); return; }
  checkColumnRef(subject.column, 'The activity subject', checkColumn, errors);
  if (!SUBJECT_TARGETS.includes(subject.targetType)) errors.push(`The activity subject "targetType" must be one of ${SUBJECT_TARGETS.join(', ')}.`);
  checkTargetEntityType(subject, 'The activity subject', errors);
}

function checkWhen(when, checkColumn, errors) {
  if (!isObject(when)) { errors.push('The activity needs a "when": { dateColumn } or { yearColumn, monthColumn }.'); return; }
  if (when.dateColumn !== undefined) {
    if (when.yearColumn !== undefined || when.monthColumn !== undefined) errors.push('The activity "when" is either a dateColumn or a yearColumn with a monthColumn, not both.');
    checkColumnRef(when.dateColumn, 'The activity date', checkColumn, errors);
    return;
  }
  checkColumnRef(when.yearColumn, 'The activity year', checkColumn, errors);
  checkColumnRef(when.monthColumn, 'The activity month', checkColumn, errors);
}

function checkMeasure(measure, checkColumn, errors) {
  if (measure === undefined) return;
  if (!isObject(measure)) { errors.push('The activity "measure" must be { column, unit? }.'); return; }
  checkColumnRef(measure.column, 'The activity measure', checkColumn, errors);
  if (measure.unit !== undefined && (typeof measure.unit !== 'string' || measure.unit.length > 16)) errors.push('The activity measure "unit" must be a short text (at most 16 characters).');
}

export function validateActivityRecipe(recipe, checkColumn, errors) {
  const a = recipe.activity;
  if (!isObject(a)) { errors.push('An activity recipe needs an "activity" object.'); return; }
  checkName(a.type, 'The activity "type"', errors);
  checkActor(a.actor, checkColumn, errors);
  checkSubject(a.subject, checkColumn, errors);
  checkWhen(a.when, checkColumn, errors);
  checkMeasure(a.measure, checkColumn, errors);
  checkExtraAttributes(a.attributes, 'The activity', checkColumn, errors, []);
}

const normalizeWhen = (w) => (isNonEmptyString(w.dateColumn) ? { dateColumn: w.dateColumn } : { yearColumn: w.yearColumn, monthColumn: w.monthColumn });

function normalizeSide(side) {
  return {
    column: side.column,
    targetType: side.targetType,
    ...(isNonEmptyString(side.targetEntityType) ? { targetEntityType: side.targetEntityType.trim() } : {}),
  };
}

export function normalizeActivityRecipe(recipe) {
  const a = recipe.activity;
  const unit = isNonEmptyString(a.measure?.unit) ? a.measure.unit.trim() : null;
  return {
    version: 1,
    template: 'activity',
    activity: {
      type: a.type.trim(),
      actor: { column: a.actor.column, targetTypes: [...a.actor.targetTypes] },
      subject: normalizeSide(a.subject),
      when: normalizeWhen(a.when),
      ...(a.measure ? { measure: { column: a.measure.column, ...(unit ? { unit } : {}) } } : {}),
      attributes: normalizeExtra(a.attributes),
    },
  };
}

// ─── relation ────────────────────────────────────────────────────────────
// The two ends are stored as attributes "left" and "right"; extra attributes may not take those names.
export const RELATION_ENDS = ['left', 'right'];

function checkRelationSide(side, end, checkColumn, errors) {
  const what = `The relation ${end} end`;
  if (!isObject(side)) { errors.push(`The relation needs a "${end}": { column, targetType }.`); return; }
  checkColumnRef(side.column, what, checkColumn, errors);
  if (!RELATION_TARGETS.includes(side.targetType)) errors.push(`${what} "targetType" must be one of ${RELATION_TARGETS.join(', ')}.`);
  checkTargetEntityType(side, what, errors);
}

export function validateRelationRecipe(recipe, checkColumn, errors) {
  const r = recipe.relation;
  if (!isObject(r)) { errors.push('A relation recipe needs a "relation" object.'); return; }
  checkName(r.type, 'The relation "type"', errors);
  checkName(r.predicate, 'The relation "predicate"', errors);
  checkRelationSide(r.left, 'left', checkColumn, errors);
  checkRelationSide(r.right, 'right', checkColumn, errors);
  if (isObject(r.left) && isObject(r.right) && r.left.column === r.right.column) errors.push('The relation\'s left and right ends must be different columns.');
  checkExtraAttributes(r.attributes, 'The relation', checkColumn, errors, RELATION_ENDS);
}

export function normalizeRelationRecipe(recipe) {
  const r = recipe.relation;
  return {
    version: 1,
    template: 'relation',
    relation: {
      type: r.type.trim(), predicate: trimmed(r.predicate),
      left: normalizeSide(r.left), right: normalizeSide(r.right),
      attributes: normalizeExtra(r.attributes),
    },
  };
}

// The entity a relation row becomes, in the collection shape applyRecipe and the
// link rules understand: named "left → right" (a column applyRelation adds to each
// row), keyed on both ends, the ends kept as attributes "left" / "right".
export const RELATION_NAME_COLUMN = '\u0000relationName';

export function relationEntityDef(relation) {
  return {
    type: relation.type,
    nameColumn: RELATION_NAME_COLUMN,
    keyColumn: RELATION_NAME_COLUMN,
    keyColumns: [relation.left.column, relation.right.column],
    attributes: [
      { column: relation.left.column, name: 'left' },
      { column: relation.right.column, name: 'right' },
      ...normalizeExtra(relation.attributes),
    ],
  };
}
