// The matrix filter's organisation condition: select accounts, identities or
// resources by what the organisation lists link to them, at query time from
// "OrgLinks" — no Context in between.
//
//   { kind: 'org',
//     entityType: 'Klant',                              required, = OrgEntities."entityType"
//     entityIds:  ['<uuid>', …],                        optional; absent/empty = every entity of the type (max 500)
//     attribute:  { key: 'iso27001', values: ['Ja'] },  optional; OrgEntities."attributes"->>key = ANY(values)
//     via:        ['eigenaar', 'Uren'],                 optional; absent/empty = every link
//     labels:     { '<uuid>': 'Contoso Bank' } }        display only, ignored here
//
// entityIds and attribute combine with AND. A `via` name is either the via of a
// DIRECT link (COALESCE(via, 'displayName')) or the entity type of a FACT list
// for THROUGH links: a fact row (a timesheet row) links to the chosen entity
// through an attribute, and the fact row's own links to system objects count.
// Same notions as orgtruth/model/linkedTo.js.
//
// Per matrix entity the linked set is widened the way a context is:
//   Principal  linked principals ∪ accounts of linked identities ∪ Principal members of linked contexts
//   Identity   linked identities ∪ identities of linked principals ∪ Identity members of linked contexts
//   Resource   linked resources ∪ Resource members of linked contexts
//
// Shared by filterSql.js (live matrix, id expression `id`) and scopeHistory.js
// (as-of scope, id expression `(state->>'id')::uuid`). Every user value is bound
// through `bind`; validation happens BEFORE the first bind so a dropped
// condition leaves no stray parameter behind.
import { UUID_RE } from '../ingest/validation.helpers.js';

export const MAX_ENTITY_IDS = 500;
export const MAX_ATTRIBUTE_KEY_LENGTH = 100;
export const MAX_ATTRIBUTE_VALUES = 200;
export const MAX_VIAS = 50;
export const MAX_NAME_LENGTH = 200;

const LINK_TARGET_TYPES = `('Principal', 'Identity', 'Resource', 'Context')`;

const fail = (error) => ({ ok: false, error });
const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

function parseEntityIds(raw) {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail('entityIds must be a list');
  if (raw.length > MAX_ENTITY_IDS) return fail(`more than ${MAX_ENTITY_IDS} entityIds`);
  if (!raw.every(id => typeof id === 'string' && UUID_RE.test(id))) return fail('entityIds must be UUIDs');
  return { ok: true, value: [...new Set(raw)] };
}

function parseAttribute(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('attribute must be { key, values }');
  const { key, values } = raw;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
    return fail(`attribute key must be 1..${MAX_ATTRIBUTE_KEY_LENGTH} characters`);
  }
  if (!Array.isArray(values)) return fail('attribute values must be a list');
  const kept = values
    .filter(v => ['string', 'number', 'boolean'].includes(typeof v))
    .map(String)
    .filter(v => v !== '');
  if (kept.length === 0) return fail('attribute needs at least one value');
  if (kept.length > MAX_ATTRIBUTE_VALUES) return fail(`more than ${MAX_ATTRIBUTE_VALUES} attribute values`);
  return { ok: true, value: { key, values: [...new Set(kept)] } };
}

function parseVia(raw) {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail('via must be a list');
  if (raw.length > MAX_VIAS) return fail(`more than ${MAX_VIAS} via names`);
  if (!raw.every(v => isText(v, MAX_NAME_LENGTH))) return fail('via names must be non-empty text');
  return { ok: true, value: [...new Set(raw)] };
}

/**
 * Validate an org condition. Returns { ok: true, value: { entityType, entityIds,
 * attribute, via } } or { ok: false, error }. A malformed part fails the whole
 * condition: dropping only that part would WIDEN the selection (every entity of
 * the type instead of the picked ones), which is the wrong way to fail.
 */
export function parseOrgCondition(cond) {
  if (!cond || typeof cond !== 'object') return fail('not an object');
  if (!isText(cond.entityType, MAX_NAME_LENGTH)) return fail('entityType is required');
  const parts = [parseEntityIds(cond.entityIds), parseAttribute(cond.attribute), parseVia(cond.via)];
  const bad = parts.find(p => !p.ok);
  if (bad) return bad;
  const [ids, attribute, via] = parts;
  return { ok: true, value: { entityType: cond.entityType, entityIds: ids.value, attribute: attribute.value, via: via.value } };
}

// A single value matches when it is one of `values`; a multi-valued attribute
// (a JSON array, e.g. expertises) when ANY of its elements is.
function attributeMatch(keyP, valuesP) {
  const attr = `e."attributes"->(${keyP}::text)`;
  return `(CASE WHEN jsonb_typeof(${attr}) = 'array'
      THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(${attr}) av WHERE av = ANY(${valuesP}::text[]))
      ELSE e."attributes"->>(${keyP}::text) = ANY(${valuesP}::text[]) END)`;
}

// The chosen org entities (CTE org_e).
function entitiesSql(spec, bind) {
  const where = [`e."entityType" = ${bind(spec.entityType)}`, `e."status" = 'accepted'`, `e."validTo" IS NULL`];
  if (spec.entityIds.length) where.push(`e."id" = ANY(${bind(spec.entityIds)}::uuid[])`);
  if (spec.attribute) where.push(attributeMatch(bind(spec.attribute.key), bind(spec.attribute.values)));
  return `SELECT e."id" FROM "OrgEntities" e WHERE ${where.join(' AND ')}`;
}

// The system objects linked to them, directly or through fact rows (CTE org_l: tt, tid).
function linksSql(spec, bind) {
  const viaP = spec.via.length ? bind(spec.via) : null;
  const directVia = viaP ? ` AND COALESCE(l."via", 'displayName') = ANY(${viaP}::text[])` : '';
  const throughVia = viaP ? ` AND f."entityType" = ANY(${viaP}::text[])` : '';
  return `SELECT l."targetType" AS tt, l."targetId" AS tid FROM "OrgLinks" l
       WHERE l."status" = 'accepted' AND l."targetType" IN ${LINK_TARGET_TYPES}
         AND l."orgEntityId" IN (SELECT "id" FROM org_e)${directVia}
      UNION
      SELECT fl."targetType", fl."targetId" FROM "OrgLinks" tl
        JOIN "OrgEntities" f ON f."id" = tl."orgEntityId" AND f."status" = 'accepted' AND f."validTo" IS NULL
        JOIN "OrgLinks" fl ON fl."orgEntityId" = f."id" AND fl."status" = 'accepted' AND fl."targetType" IN ${LINK_TARGET_TYPES}
       WHERE tl."status" = 'accepted' AND tl."targetType" = 'OrgEntity'
         AND COALESCE(tl."via", 'displayName') <> 'displayName'
         AND tl."targetId" IN (SELECT "id" FROM org_e)${throughVia}
      UNION
      ${activitySql(viaP)}`;
}

// Activity (a timesheet imported with the activity template): the actors whose
// accepted activity rows point at one of the chosen entities. The via name of an
// activity is its activity type ('Uren'), like the fact list's type above.
function activitySql(viaP) {
  const typeVia = viaP ? ` AND a."activityType" = ANY(${viaP}::text[])` : '';
  return `SELECT DISTINCT ak."targetType", ak."targetId" FROM "OrgActivities" a
        JOIN "OrgActivityKeys" sk ON sk."id" = a."subjectKeyId" AND sk."status" = 'accepted' AND sk."targetType" = 'OrgEntity'
        JOIN "OrgActivityKeys" ak ON ak."id" = a."actorKeyId" AND ak."status" = 'accepted' AND ak."targetType" IN ('Principal', 'Identity', 'Resource')
       WHERE sk."targetId" IN (SELECT "id" FROM org_e)${typeVia}`;
}

const contextMembers = (memberType) =>
  `SELECT cm."memberId" FROM "ContextMembers" cm JOIN org_l x ON x.tt = 'Context' AND x.tid = cm."contextId" WHERE cm."memberType" = '${memberType}'`;

const MEMBER_SQL = {
  Principal: [
    `SELECT tid FROM org_l WHERE tt = 'Principal'`,
    `SELECT im."principalId" FROM "IdentityMembers" im JOIN org_l x ON x.tt = 'Identity' AND x.tid = im."identityId"`,
    contextMembers('Principal'),
  ],
  Identity: [
    `SELECT tid FROM org_l WHERE tt = 'Identity'`,
    `SELECT im."identityId" FROM "IdentityMembers" im JOIN org_l x ON x.tt = 'Principal' AND x.tid = im."principalId"`,
    contextMembers('Identity'),
  ],
  Resource: [
    `SELECT tid FROM org_l WHERE tt = 'Resource'`,
    contextMembers('Resource'),
  ],
};

/**
 * Build the predicate for one org condition: `<idExpr> IN (…)`.
 * Returns { clause } or { warning } (the condition is then dropped, like an
 * unknown context).
 */
export function orgConditionClause({ entity, idExpr, cond, bind }) {
  if (!Object.hasOwn(MEMBER_SQL, entity)) return { warning: `org condition not supported for ${entity} — dropped` };
  const parsed = parseOrgCondition(cond);
  if (!parsed.ok) return { warning: `org condition dropped: ${parsed.error}` };
  const spec = parsed.value;
  const clause = `${idExpr} IN (
    WITH org_e AS (${entitiesSql(spec, bind)}),
         org_l AS (${linksSql(spec, bind)})
    ${MEMBER_SQL[entity].join('\n    UNION\n    ')})`;
  return { clause };
}
