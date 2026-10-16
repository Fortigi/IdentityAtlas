// The matrix filter's enrichment attribute condition: an ordinary attribute
// condition whose field names an enrichment list's attribute,
//
//   { kind: 'attribute', field: 'org.<SourceType>.<attr>', values: ['IAM', 'Azure'] }
//   e.g. field 'org.Maten.expertises'
//
// <SourceType> is the enrichment's entity type (OrgEntities."entityType"), <attr>
// the attribute key; the source type runs up to the first dot after 'org.', the
// rest is the attribute (so an attribute name may itself hold a dot).
//
// An account, identity or resource matches when an accepted, current enrichment
// row ABOUT it (orgtruth/enrichment/sql.js: the row's key link) has the attribute
// with one of `values`. A multi-valued attribute matches when ANY of its values is
// in `values` — 'IAM' matches a person whose expertises are ['IAM', 'Azure'];
// an exact match on the whole list is not what is asked. Put the condition in the
// exclude block for "but not C".
//
// Widened across identity ↔ accounts the way the org condition is:
//   Principal  rows about the principal ∪ rows about the identity it belongs to
//   Identity   rows about the identity ∪ rows about any of its accounts
//   Resource   rows about the resource
//
// Shared by filterSql.js (live matrix, id expression `id`) and scopeHistory.js
// (as-of scope, id expression `(state->>'id')::uuid`; enrichment rows are read as
// they are now, like context membership). Every user value is bound through
// `bind`, and only after validation, so a dropped condition leaves no stray
// parameter behind.
import { enrichmentTargetsSql, attributeValuesSql } from '../orgtruth/enrichment/sql.js';

export const ENRICHMENT_PREFIX = 'org.';
export const MAX_SOURCE_LENGTH = 200;
export const MAX_ATTRIBUTE_LENGTH = 100;
export const MAX_VALUES = 200;

export const isEnrichmentField = (field) => typeof field === 'string' && field.startsWith(ENRICHMENT_PREFIX);

/** 'org.Maten.expertises' → { source: 'Maten', attribute: 'expertises' }, or null. */
export function parseEnrichmentField(field) {
  if (!isEnrichmentField(field)) return null;
  const rest = field.slice(ENRICHMENT_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 1 || dot === rest.length - 1) return null;
  const source = rest.slice(0, dot);
  const attribute = rest.slice(dot + 1);
  if (source.length > MAX_SOURCE_LENGTH || attribute.length > MAX_ATTRIBUTE_LENGTH) return null;
  return { source, attribute };
}

/** 'Maten', 'expertises' → 'org.Maten.expertises'. */
export const enrichmentField = (source, attribute) => `${ENRICHMENT_PREFIX}${source}.${attribute}`;

function cleanValues(values) {
  if (!Array.isArray(values)) return [];
  const kept = values.filter(v => v !== null && v !== undefined && v !== '').map(String);
  return [...new Set(kept)].slice(0, MAX_VALUES);
}

const MEMBER_SQL = {
  Principal: [
    `SELECT tid FROM enr_t WHERE tt = 'Principal'`,
    `SELECT im."principalId" FROM "IdentityMembers" im JOIN enr_t x ON x.tt = 'Identity' AND x.tid = im."identityId"`,
  ],
  Identity: [
    `SELECT tid FROM enr_t WHERE tt = 'Identity'`,
    `SELECT im."identityId" FROM "IdentityMembers" im JOIN enr_t x ON x.tt = 'Principal' AND x.tid = im."principalId"`,
  ],
  Resource: [
    `SELECT tid FROM enr_t WHERE tt = 'Resource'`,
  ],
};

/**
 * Build the predicate for one enrichment attribute condition: `<idExpr> IN (…)`.
 * Returns { clause } or { warning } (the condition is then dropped).
 */
export function enrichmentConditionClause({ entity, idExpr, field, values, bind }) {
  if (!Object.hasOwn(MEMBER_SQL, entity)) return { warning: `enrichment attribute not supported for ${entity} — dropped` };
  const parsed = parseEnrichmentField(field);
  const vals = cleanValues(values);
  if (!parsed || vals.length === 0) return { warning: `attribute condition for ${field} dropped` };
  const sourceP = bind(parsed.source);
  const keyP = bind(parsed.attribute);
  const valuesP = bind(vals);
  const match = `EXISTS (SELECT 1 FROM ${attributeValuesSql('e', keyP)} AS ev(v) WHERE ev.v = ANY(${valuesP}::text[]))`;
  const clause = `${idExpr} IN (
    WITH enr_t AS (${enrichmentTargetsSql([`e."entityType" = ${sourceP}`, match])})
    ${MEMBER_SQL[entity].join('\n    UNION\n    ')})`;
  return { clause };
}
