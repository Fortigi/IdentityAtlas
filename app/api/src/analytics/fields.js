// The whitelist of reporting fields an Analytics Profile may select.
//
// A field id is `<Entity>.<property>` for a core field, or `<Entity>.ext.<key>`
// for an `extendedAttributes` key discovered in this install. Nothing outside
// this registry ever reaches SQL: core fields map to a fixed column, and a
// discovered key is passed as a BIND PARAMETER (`->> $n`), never interpolated.
//
// Each core field says:
//   column      — the column it reads on its entity's table
//   type        — boolean | enum | text (all dimension VALUES are emitted as text)
//   bounded     — true when the value set is closed (boolean, a fixed enum); any
//                 other field's distinct count is MEASURED when a profile is saved
//   reportable  — false for identifiers and free text, with the reason, so the
//                 catalog can explain why it cannot be a dimension
//
// History: only Principals are audited with full-row snapshots among the
// entities offered here, so only Principal fields have `history: true`
// (docs/architecture/analytics-profiles.md §2.3).

import { discoverExtendedAttrKeys } from '../db/columnCache.js';
import { getAttributeLabels } from '../lib/attributeLabels.js';
import { iriFor } from './ontologyTerms.js';

export const ENTITIES = Object.freeze({
  Principal: { table: 'Principals', labelTarget: 'principal', history: true },
  Identity: { table: 'Identities', labelTarget: 'identity', history: false },
  Resource: { table: 'Resources', labelTarget: 'resource', history: false },
});

const NOT_REPORTABLE_ID = 'An identifier: one value per row, so every cell would be a single entity.';
const NOT_REPORTABLE_TEXT = 'Free text: values are not categories and would reveal individual records.';

const def = (entity, property, label, extra) => ({
  id: `${entity}.${property}`, entity, property, label, reportable: true, bounded: false, type: 'text', ...extra,
});

const CORE = [
  def('Principal', 'accountEnabled', 'Account enabled', { column: 'accountEnabled', type: 'boolean', bounded: true }),
  def('Principal', 'principalType', 'Account type', { column: 'principalType', type: 'enum', bounded: true }),
  def('Principal', 'department', 'Department (account)', { column: 'department' }),
  def('Principal', 'companyName', 'Company (account)', { column: 'companyName' }),
  def('Principal', 'jobTitle', 'Job title (account)', { column: 'jobTitle' }),
  def('Principal', 'system', 'System', { systemName: true, type: 'enum' }),
  def('Principal', 'displayName', 'Name', { column: 'displayName', reportable: false, reason: NOT_REPORTABLE_ID }),
  def('Principal', 'email', 'Email', { column: 'email', reportable: false, reason: NOT_REPORTABLE_ID }),
  def('Principal', 'employeeId', 'Employee ID', { column: 'employeeId', reportable: false, reason: NOT_REPORTABLE_ID }),

  def('Identity', 'department', 'Department', { column: 'department' }),
  def('Identity', 'companyName', 'Company', { column: 'companyName' }),
  def('Identity', 'jobTitle', 'Job title', { column: 'jobTitle' }),
  def('Identity', 'country', 'Country', { column: 'country' }),
  def('Identity', 'city', 'City', { column: 'city' }),
  def('Identity', 'officeLocation', 'Office', { column: 'officeLocation' }),
  def('Identity', 'displayName', 'Name', { column: 'displayName', reportable: false, reason: NOT_REPORTABLE_ID }),
  def('Identity', 'email', 'Email', { column: 'email', reportable: false, reason: NOT_REPORTABLE_ID }),
  def('Identity', 'analystNotes', 'Analyst notes', { column: 'analystNotes', reportable: false, reason: NOT_REPORTABLE_TEXT }),

  def('Resource', 'resourceType', 'Resource type', { column: 'resourceType', type: 'enum' }),
  def('Resource', 'system', 'Resource system', { systemName: true, type: 'enum' }),
  def('Resource', 'displayName', 'Resource name', { column: 'displayName', reportable: false, reason: NOT_REPORTABLE_ID }),
  def('Resource', 'description', 'Description', { column: 'description', reportable: false, reason: NOT_REPORTABLE_TEXT }),
];

export const CORE_FIELDS = Object.freeze(Object.fromEntries(CORE.map(f => [f.id, Object.freeze(f)])));

const EXT_ID = /^(Principal|Identity|Resource)\.ext\.([A-Za-z0-9_]{1,128})$/;

/** Parse `<Entity>.ext.<key>`; null when the id is not a well-formed discovered-field id. */
export function parseExtFieldId(fieldId) {
  const m = typeof fieldId === 'string' ? EXT_ID.exec(fieldId) : null;
  return m ? { entity: m[1], key: m[2] } : null;
}

/**
 * Resolve a field id to its definition WITHOUT a database round trip. A
 * discovered key resolves on syntax alone; whether it exists is checked when the
 * profile is saved (resolveFieldsForSave). Returns null for anything else.
 */
export function resolveField(fieldId) {
  if (typeof fieldId === 'string' && Object.hasOwn(CORE_FIELDS, fieldId)) return CORE_FIELDS[fieldId];
  const ext = parseExtFieldId(fieldId);
  if (!ext) return null;
  return {
    id: fieldId, entity: ext.entity, property: `ext.${ext.key}`, extKey: ext.key, label: ext.key,
    type: 'text', reportable: true, bounded: false, discovered: true,
  };
}

/** The entity alias each SQL builder uses. */
export const ALIASES = Object.freeze({ Principal: 'p', Identity: 'i', Resource: 'r' });

/**
 * SQL value expression for a field against the live tables (aliases above).
 * `bind(value)` returns a `$n` placeholder; it is used for discovered keys.
 * Emits text: booleans render as 'true'/'false' like `->>` does.
 */
export function fieldSql(field, bind) {
  const t = ALIASES[field.entity];
  if (field.discovered) return `(${t}."extendedAttributes" ->> ${bind(field.extKey)}::text)`;
  if (field.systemName) return `(SELECT s."displayName" FROM "Systems" s WHERE s."id" = ${t}."systemId")`;
  return `(${t}."${field.column}")::text`;
}

/**
 * The same value read from an as-of `state` jsonb snapshot (Principals only —
 * the only entity offered here whose full rows are audited).
 */
export function fieldStateSql(field, stateAlias, bind) {
  if (field.entity !== 'Principal') return null;
  if (field.discovered) return `(${stateAlias} -> 'extendedAttributes' ->> ${bind(field.extKey)}::text)`;
  if (field.systemName) {
    return `(SELECT s."displayName" FROM "Systems" s WHERE s."id"::text = ${stateAlias} ->> 'systemId')`;
  }
  return `(${stateAlias} ->> '${field.column}')`;
}

/** Catalog view of one field (what GET /catalog returns). */
export function describeField(field) {
  return {
    id: field.id,
    iri: iriFor(field.id),
    entity: field.entity,
    label: field.label,
    type: field.type,
    reportable: field.reportable,
    ...(field.reportable ? {} : { reason: field.reason }),
    cardinality: field.bounded ? 'bounded' : 'measured on save',
    history: ENTITIES[field.entity].history ? 'reconstructable' : 'current only',
    origin: field.discovered ? 'discovered' : 'core',
  };
}

/**
 * Every field the catalog offers: core fields plus this install's discovered
 * `extendedAttributes` keys (the same discovery and 300-key cap the list pages
 * use), labelled with the admin's attribute labels where set.
 */
export async function listFields() {
  const out = Object.values(CORE_FIELDS).map(describeField);
  for (const [entity, { table, labelTarget }] of Object.entries(ENTITIES)) {
    const keys = await discoverExtendedAttrKeys(table);
    // Labels are cosmetic; a failed lookup must not cost the field.
    const labels = await getAttributeLabels(labelTarget).catch(() => ({}));
    for (const key of keys) {
      const field = resolveField(`${entity}.ext.${key}`);
      if (!field) continue;
      out.push(describeField({ ...field, label: Object.hasOwn(labels, key) ? labels[key] : key }));
    }
  }
  return out;
}

/** The discovered keys of one entity, as a Set (for save-time existence checks). */
export async function discoveredKeys(entity) {
  return new Set(await discoverExtendedAttrKeys(ENTITIES[entity].table));
}
