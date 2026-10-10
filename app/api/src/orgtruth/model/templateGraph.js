// Organisation truth — what the four import templates add to the meta-model
// (GET /org-truth/model, merged in by metaGraph.js). Shapes:
//
//   templates:   Map<entityType, template>   the template of each entity type's
//                rows (the most frequent one, should a type ever be imported by
//                two templates) — becomes entityTypes[].template
//   enrichments: [{ type, targetType, profileName, attributes: [{ name, multi }], linked, unlinked }]
//   activities:  [{ type, profileName, actorTypes, subjectType, subjectEntityType, rows, unit,
//                   total, firstOn, lastOn, keys: { actor: { accepted, proposed, unmatched }, subject: {…} } }]
//   pairs:       [{ type, predicate, leftType, rightType, count }]
//
// Semantics:
//   - enrichments: one per (entity type, profile name). `linked` = rows (not
//     rejected, the model's claim filter) about an object of the target type
//     through their key link (orgtruth/enrichment/sql.js); `unlinked` the rest.
//     targetType and attributes come from the newest profile version's recipe
//     (`enrich.targetType`, the entity definition's attributes with `multi`).
//   - activities: one per (activity type, profile name) over OrgActivities, with
//     the sourceId filter applied to the activity rows. `total` is the sum of
//     `measure`, firstOn/lastOn the earliest/latest `occurredOn` (YYYY-MM-DD).
//     `keys` counts the profile's distinct referenced values per role and status
//     (rejected keys are not counted). Actor/subject types from the recipe.
//   - pairs: one per (relation type, profile name); `count` = accepted rows;
//     an end that is another list reads as that list's entity type.
import * as db from '../../db/connection.js';
import { createParams } from '../../db/sqlParams.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { ENTITY_TEMPLATE_SQL } from '../templates.js';
import { enrichmentTargetsSql } from '../enrichment/sql.js';
import { claimFilter } from './claimFilter.js';
import { round2 } from '../activity/sql.js';

const KEY_STATUSES = ['accepted', 'proposed', 'unmatched'];

async function templateRows(filters) {
  const { params, bind } = createParams();
  return (await db.query(`
    SELECT e."entityType" AS type, ${ENTITY_TEMPLATE_SQL('e')} AS template, COUNT(*)::int AS n
      FROM "OrgEntities" e
     WHERE ${claimFilter('e', filters, bind)}
     GROUP BY 1, 2
     ORDER BY 1, n DESC, 2
  `, params)).rows;
}

async function enrichmentRows(filters) {
  const { params, bind } = createParams();
  return (await db.query(`
    WITH t AS (SELECT DISTINCT x."entityId" FROM (${enrichmentTargetsSql()}) x)
    SELECT e."entityType" AS type, p."name" AS "profileName",
           COUNT(t."entityId")::int AS linked, COUNT(*)::int AS "rowCount"
      FROM "OrgEntities" e
      JOIN "OrgImportProfiles" p ON p."id" = e."profileId"
      LEFT JOIN t ON t."entityId" = e."id"
     WHERE p."template" = 'enrichment' AND ${claimFilter('e', filters, bind)}
     GROUP BY 1, 2
     ORDER BY 1, 2
  `, params)).rows;
}

async function pairRows(filters) {
  const { params, bind } = createParams();
  return (await db.query(`
    SELECT e."entityType" AS type, p."name" AS "profileName",
           COUNT(*) FILTER (WHERE e.status = 'accepted')::int AS count
      FROM "OrgEntities" e
      JOIN "OrgImportProfiles" p ON p."id" = e."profileId"
     WHERE p."template" = 'relation' AND ${claimFilter('e', filters, bind)}
     GROUP BY 1, 2
     ORDER BY 1, 2
  `, params)).rows;
}

async function activityRows({ sourceId }) {
  return (await db.query(`
    SELECT a."activityType" AS type, a."profileName", COUNT(*)::int AS "rowCount", MAX(a."unit") AS unit,
           COALESCE(SUM(a."measure"), 0)::float8 AS total,
           to_char(MIN(a."occurredOn"), 'YYYY-MM-DD') AS "firstOn",
           to_char(MAX(a."occurredOn"), 'YYYY-MM-DD') AS "lastOn"
      FROM "OrgActivities" a
     WHERE ($1::uuid IS NULL OR a."sourceId" = $1::uuid)
     GROUP BY 1, 2
     ORDER BY 1, 2
  `, [sourceId || null])).rows;
}

async function activityKeyRows() {
  return (await db.query(`
    SELECT "profileName", "role", "status", COUNT(*)::int AS n
      FROM "OrgActivityKeys"
     GROUP BY 1, 2, 3
  `)).rows;
}

/** Pure: (type, template, n) rows ordered most frequent first → Map type → template. */
export function templatesByType(rows) {
  const out = new Map();
  for (const r of rows) if (!out.has(r.type)) out.set(r.type, r.template);
  return out;
}

const recipeOf = (profilesByName, name) => parseJsonbColumn(profilesByName.get(name)?.recipe) ?? {};

/** The attribute list of an enrichment's entity definition (its own type, else the only one). */
export function enrichmentAttributes(recipe, type) {
  const defs = Array.isArray(recipe?.entities) ? recipe.entities : [];
  const def = defs.find(d => d?.type === type) ?? defs[0];
  const attrs = Array.isArray(def?.attributes) ? def.attributes : [];
  return attrs.map(a => ({ name: a.name ?? a.column, multi: a.multi === true }));
}

/** Pure: key rows → Map profileName → { actor: {…}, subject: {…} } (zeros filled in). */
const zero = () => Object.fromEntries(KEY_STATUSES.map(s => [s, 0]));
const emptyKeys = () => ({ actor: zero(), subject: zero() });

export function keyCounts(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!KEY_STATUSES.includes(r.status)) continue;
    const entry = out.get(r.profileName) ?? emptyKeys();
    if (entry[r.role]) entry[r.role][r.status] += r.n;
    out.set(r.profileName, entry);
  }
  return out;
}

const endType = (end) => (end?.targetType === 'OrgEntity' && end.targetEntityType ? end.targetEntityType : end?.targetType ?? null);

/** Pure: the rows of the four queries + the newest profile per name → the template parts. */
export function shapeTemplateGraph({ templates, enrichments, activities, keys, pairs, profiles }) {
  const byName = new Map(profiles.map(p => [p.name, p]));
  const counts = keyCounts(keys);
  return {
    templates: templatesByType(templates),
    enrichments: enrichments.map(r => {
      const recipe = recipeOf(byName, r.profileName);
      return {
        type: r.type, targetType: recipe.enrich?.targetType ?? null, profileName: r.profileName,
        attributes: enrichmentAttributes(recipe, r.type), linked: r.linked, unlinked: r.rowCount - r.linked,
      };
    }),
    activities: activities.map(r => {
      const act = recipeOf(byName, r.profileName).activity ?? {};
      return {
        type: r.type, profileName: r.profileName,
        actorTypes: Array.isArray(act.actor?.targetTypes) ? act.actor.targetTypes : [],
        subjectType: act.subject?.targetType ?? null, subjectEntityType: act.subject?.targetEntityType ?? null,
        rows: r.rowCount, unit: r.unit ?? act.measure?.unit ?? null, total: round2(r.total),
        firstOn: r.firstOn, lastOn: r.lastOn,
        keys: counts.get(r.profileName) ?? emptyKeys(),
      };
    }),
    pairs: pairs.map(r => {
      const rel = recipeOf(byName, r.profileName).relation ?? {};
      return { type: r.type, predicate: rel.predicate ?? null, leftType: endType(rel.left), rightType: endType(rel.right), count: r.count };
    }),
  };
}

/**
 * @param {{ includeClosed?: boolean, sourceId?: string|null }} filters
 * @param {Array<{ name: string, recipe: object }>} profiles newest version per name
 */
export async function getTemplateGraph(filters, profiles) {
  const [templates, enrichments, activities, keys, pairs] = await Promise.all([
    templateRows(filters), enrichmentRows(filters), activityRows(filters), activityKeyRows(), pairRows(filters),
  ]);
  return shapeTemplateGraph({ templates, enrichments, activities, keys, pairs, profiles });
}
