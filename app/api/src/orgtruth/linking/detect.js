// Organisation truth — which org attributes match which system fields
// (owned by workstream T2). Feeds wizard step 4 ("Owner matches 94 % unique on
// Principal.email, accept?").
//
//   detectLinks(entities, entityType, recipeEntityDef) → Promise<pair[]>
//   detectPairs(entities, attributes, rowsByType)      → pair[]          (pure core)
//   entitiesFromRows(rows, entityDef)                  → entity[]        (pure; the `rows` fallback)
//
// pair: { attribute, targetType, targetField, type, unique, multiple, none, values, uniquePct, suggestedWeight }
//   unique    values matching exactly one system row (a cell listing several people counts per person)
//   multiple  values matching several rows
//   none      values with no match (an empty attribute counts once here)
//   values    the number of values scored
//   uniquePct round(100 * unique / values)
// Sorted by uniquePct desc (then suggestedWeight desc); pairs with unique === 0 dropped.
//
// Which signal types are tried per (attribute, field):
//   exact   always
//   prefix  e-mail-shaped attribute × an e-mail field (Principal/Identity.email, Resource.mail)
//   name    text attribute × Principal/Identity.displayName (person names)
//   token   text attribute × Resource/Context.displayName (group and context names)
// DECISION (T2): token is offered only against Resource and Context names —
// on person names it duplicates `name` with a weaker rule. An attribute is
// e-mail-shaped when ≥ 80 % of its non-empty values look like an address
// (the same 80 % rule T1's column profile uses).
import { LINK_TARGETS, NAME_ATTRIBUTE, entityAttributeNames } from '../contracts.js';
import { loadTargets, buildRuleIndex } from './candidates.js';
import { orgValueOf, normValue } from './signals.js';
import { scoreEntity, valuesOf, withValue } from './score.js';

export const SHAPE_SHARE = 0.8;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_FIELDS = new Set(['email', 'mail']);
const PERSON_TARGETS = new Set(['Principal', 'Identity']);
const PROBE_WEIGHT = 100;

/** The weight the wizard pre-fills for a detected pair. */
export function suggestedWeight(type, targetField) {
  if (type === 'prefix') return 80;
  if (type === 'name') return 60;
  if (type === 'token') return 50;
  if (type === 'fuzzy') return 100;
  if (targetField === 'employeeId' || targetField === 'externalId') return 95;
  if (EMAIL_FIELDS.has(targetField)) return 90;
  return 70;
}

/** 'email' when ≥ 80 % of the non-empty values look like an address, else 'text'; null when all empty. */
export function attributeShape(values) {
  const filled = values.filter(Boolean);
  if (filled.length === 0) return null;
  const emails = filled.filter(v => EMAIL_RE.test(v)).length;
  return emails / filled.length >= SHAPE_SHARE ? 'email' : 'text';
}

/** Signal types worth trying for one attribute shape against one target field. */
export function signalTypesFor(shape, targetType, targetField) {
  const types = ['exact'];
  if (shape === 'email' && EMAIL_FIELDS.has(targetField)) types.push('prefix');
  if (shape === 'text' && targetField === NAME_ATTRIBUTE) {
    if (PERSON_TARGETS.has(targetType)) types.push('name');
    else types.push(...(targetType === 'OrgEntity' ? ['fuzzy'] : ['token', 'fuzzy']));
  }
  return types;
}

function probeRule(attribute, targetType, targetField, type) {
  return {
    entityType: '_detect', targetType, threshold: 0,
    signals: [{ name: 'probe', attribute, targetField, type, weight: PROBE_WEIGHT, order: 0 }],
  };
}

// Per VALUE of the attribute (a cell listing three people counts three); an
// empty attribute is not counted at all (an empty team cell is not a miss).
function countMatches(entities, attribute, ruleIndex) {
  let unique = 0;
  let multiple = 0;
  let total = 0;
  for (const e of entities) {
    for (const v of valuesOf(e, attribute)) {
      total += 1;
      const n = scoreEntity(withValue(e, attribute, v), ruleIndex).allCandidates.length;
      if (n === 1) unique += 1;
      else if (n > 1) multiple += 1;
    }
  }
  return { unique, multiple, none: total - unique - multiple, values: total };
}

export function detectPairs(entities, attributes, rowsByType) {
  const list = entities ?? [];
  const indexCache = new Map();
  const indexFor = (targetType, targetField, type) => {
    const key = `${targetType}|${targetField}|${type}`;
    if (!indexCache.has(key)) {
      indexCache.set(key, buildRuleIndex(rowsByType.get(targetType) ?? [], probeRule('_', targetType, targetField, type)).bySignal);
    }
    return indexCache.get(key);
  };

  const out = [];
  for (const attribute of attributes) {
    const shape = attributeShape(list.flatMap(e => valuesOf(e, attribute)));
    for (const { targetType, targetField, type } of probesFor(shape, rowsByType)) {
      const ruleIndex = { rule: probeRule(attribute, targetType, targetField, type), bySignal: indexFor(targetType, targetField, type) };
      const counts = countMatches(list, attribute, ruleIndex);
      if (counts.unique === 0) continue;
      out.push({
        attribute, targetType, targetField, type, ...counts,
        uniquePct: Math.round((100 * counts.unique) / counts.values),
        suggestedWeight: suggestedWeight(type, targetField),
      });
    }
  }
  return out.sort((a, b) => b.uniquePct - a.uniquePct || b.suggestedWeight - a.suggestedWeight);
}

/** Every (targetType, targetField, type) to try for an attribute shape; none for an all-empty attribute. */
export function probesFor(shape, rowsByType) {
  if (!shape) return [];
  const probes = [];
  for (const [targetType, fields] of Object.entries(LINK_TARGETS)) {
    if (!rowsByType.has(targetType)) continue;
    for (const targetField of fields) {
      for (const type of signalTypesFor(shape, targetType, targetField)) probes.push({ targetType, targetField, type });
    }
  }
  return probes;
}

export async function detectLinks(entities, entityType, recipeEntityDef) {
  const ofType = (entities ?? []).filter(e => e.entityType === entityType);
  if (ofType.length === 0) return [];
  const rowsByType = new Map();
  for (const [targetType, fields] of Object.entries(LINK_TARGETS)) {
    rowsByType.set(targetType, await loadTargets(targetType, fields));
  }
  return detectPairs(ofType, entityAttributeNames(recipeEntityDef), rowsByType);
}

/**
 * The rows fallback of POST /links/detect (until T1's applyRecipe is wired):
 * one entity per row with a non-empty name, de-duplicated on the key column
 * (default the name column), first row wins. Attribute names default to the
 * column header, as normalizeRecipe does.
 */
export function entitiesFromRows(rows, entityDef) {
  const keyColumn = entityDef.keyColumn ?? entityDef.nameColumn;
  const seen = new Set();
  const out = [];
  for (const row of rows ?? []) {
    const displayName = String(row?.[entityDef.nameColumn] ?? '').trim();
    const key = normValue(row?.[keyColumn]);
    if (!displayName || !key || seen.has(key)) continue;
    seen.add(key);
    const attributes = {};
    for (const a of entityDef.attributes ?? []) attributes[a.name ?? a.column] = row[a.column] ?? null;
    out.push({ entityType: entityDef.type, displayName, canonicalKey: key, attributes });
  }
  return out;
}
