// Organisation truth — load and index the system rows an org entity can be
// linked to (owned by workstream T2).
//
//   loadTargets(targetType, ruleOrFields) → rows { id, displayName, <fields>, [principalType] }
//   buildRuleIndex(rows, rule)         → { rule, bySignal: Map<signalName, Map<key, row[]>> }
//   loadRuleIndexes(rules)             → Map<ruleKey, ruleIndex>  (one SQL load per targetType; several rules per entity type)
//
// WHITELIST: the SELECT is built from LINK_TARGETS[targetType] filtered by the
// requested fields — never from the request strings themselves — so a rule
// naming a column outside LINK_TARGETS cannot reach SQL. The table name comes
// from TARGET_TABLES below, keyed by the same whitelist.
//
// Soft delete: Principals and Resources carry "deletedAt" (040_soft_delete.sql);
// Identities and Contexts have no soft-delete column.
//
// Non-human principals (ServicePrincipal, ManagedIdentity, AIAgent) count only
// for a rule whose signals all target displayName: a CMDB asset may well be a
// service principal by name, a person's e-mail never is. Loaded by a rule, the
// exclusion is in SQL; a shared load (several rules on one target type) keeps
// them and buildRuleIndex drops them per rule.
import { query } from '../../db/connection.js';
import { LINK_TARGETS, NAME_ATTRIBUTE, ruleName } from '../contracts.js';
import { NON_HUMAN_PRINCIPAL_TYPES } from '../../accountlinking/orphanQuery.js';
import { OWNERSHIP_TYPES_SQL } from '../../lib/ownershipTypes.js';
import { signalKeys } from './signals.js';

export const TARGET_TABLES = Object.freeze({
  Principal: { table: 'Principals', softDelete: true },
  Identity:  { table: 'Identities', softDelete: false },
  Resource:  { table: 'Resources', softDelete: true },
  Context:   { table: 'Contexts', softDelete: false },
  OrgEntity: { table: 'OrgEntities', softDelete: false },
});

/** The whitelisted fields of `fields` for a target type, in LINK_TARGETS order. */
export function allowedFields(targetType, fields) {
  const allowed = LINK_TARGETS[targetType];
  if (!allowed) throw new Error(`Unknown link target type "${targetType}".`);
  const want = new Set(fields ?? []);
  return allowed.filter(f => want.has(f));
}

/**
 * The SELECT for one target type. Column names come only from LINK_TARGETS.
 * `humanOnly` (Principals) adds a principalType filter bound to $1.
 */
export function buildTargetsSql(targetType, fields, { humanOnly = false } = {}) {
  const cols = new Set(['id', NAME_ATTRIBUTE, ...allowedFields(targetType, fields)]);
  if (targetType === 'Principal') cols.add('principalType');
  if (targetType === 'OrgEntity') cols.add('entityType');
  const { table, softDelete } = TARGET_TABLES[targetType];
  const where = [];
  if (softDelete) where.push('"deletedAt" IS NULL');
  if (humanOnly && targetType === 'Principal') where.push('("principalType" IS NULL OR "principalType" <> ALL($1::text[]))');
  // An ownership row is named after the group it is the ownership OF: linking a
  // list row to "Finance" must find the group, not its owners' row (a tie otherwise).
  if (targetType === 'Resource') where.push(`("resourceType" IS NULL OR "resourceType" NOT IN ${OWNERSHIP_TYPES_SQL})`);
  // Another list's entity only counts while it is a current, accepted claim.
  if (targetType === 'OrgEntity') where.push(`"status" = 'accepted' AND "validTo" IS NULL`);
  const select = [...cols].map(c => `"${c}"`).join(', ');
  return `SELECT ${select} FROM "${table}"${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
}

/**
 * loadTargets(targetType, ruleOrFields)
 *   - a RULE: fields from its signals; for Principals the non-human classes are
 *     excluded in SQL unless every signal targets displayName.
 *   - a field ARRAY: every row (detection, and the per-targetType shared load
 *     in loadRuleIndexes, which filters non-human rows per rule in buildRuleIndex).
 */
export async function loadTargets(targetType, ruleOrFields) {
  if (Array.isArray(ruleOrFields) || ruleOrFields == null) {
    return (await query(buildTargetsSql(targetType, ruleOrFields))).rows;
  }
  const fields = (ruleOrFields.signals ?? []).map(s => s.targetField);
  const humanOnly = targetType === 'Principal' && !displayNameOnly(ruleOrFields);
  const sql = buildTargetsSql(targetType, fields, { humanOnly });
  return (await (humanOnly ? query(sql, [NON_HUMAN_PRINCIPAL_TYPES]) : query(sql))).rows;
}

const isNonHuman = (row) => NON_HUMAN_PRINCIPAL_TYPES.includes(row.principalType);

/** True when every signal of the rule targets displayName (non-human rows stay in). */
export function displayNameOnly(rule) {
  return (rule.signals ?? []).every(s => s.targetField === NAME_ATTRIBUTE);
}

function push(map, key, row) {
  const list = map.get(key);
  if (list) list.push(row); else map.set(key, [row]);
}

/** One Map<key, row[]> per signal of the rule. */
export function buildRuleIndex(rows, rule) {
  const keepNonHuman = displayNameOnly(rule);
  // An org entity never links to an entity of its own type: a timesheet row
  // named after its customer must find the customer list, not its sibling rows.
  const usable = (keepNonHuman ? rows : rows.filter(r => !isNonHuman(r)))
    .filter(r => rule.targetType !== 'OrgEntity' || r.entityType !== rule.entityType)
    // a rule to another list may name which list (targetEntityType)
    .filter(r => rule.targetType !== 'OrgEntity' || !rule.targetEntityType || r.entityType === rule.targetEntityType);
  const bySignal = new Map();
  for (const s of rule.signals) {
    const idx = new Map();
    for (const row of usable) {
      for (const key of signalKeys(s.type, row[s.targetField])) push(idx, key, row);
    }
    bySignal.set(s.name, idx);
  }
  return { rule, bySignal };
}

/** The key a rule index is stored under: the rule's name (entityType → targetType via attribute). */
export const ruleKey = (rule) => rule.name ?? ruleName(rule);

/** Load every target type the rules need once (union of fields), index per rule (Map<ruleKey, ruleIndex>). */
export async function loadRuleIndexes(rules) {
  const rulesByType = new Map();
  for (const rule of rules ?? []) {
    rulesByType.set(rule.targetType, [...(rulesByType.get(rule.targetType) ?? []), rule]);
  }
  // One rule on a target type: load by the rule (non-human filter in SQL).
  // Several: one load with the union of their fields, filtered per rule below.
  const rowsByType = new Map();
  for (const [targetType, group] of rulesByType) {
    const what = group.length === 1 ? group[0] : group.flatMap(r => (r.signals ?? []).map(s => s.targetField));
    rowsByType.set(targetType, await loadTargets(targetType, what));
  }
  const out = new Map();
  for (const rule of rules ?? []) {
    out.set(ruleKey(rule), buildRuleIndex(rowsByType.get(rule.targetType), rule));
  }
  return out;
}
