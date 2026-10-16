// Context recipe, target 'principal' — the SQL half.
//
// A principal recipe collects the users who have access to the resources the recipe
// matches, or who belong to the organisation entities its terms match. matches.js already
// finds the resources; this module reads the rest, read-only and with a statement timeout:
//
//   buildOrgCandidateQuery()  current accepted org entities of a COLLECTION import whose
//                             normalised name any kept term finds, plus the pinned ones
//   buildAccessQuery()        who holds an assignment of the chosen types on a resource
//   buildOrgLinkQuery()       who is linked to each org entity — one orgConditionClause per
//                             entity (matrix/orgCondition.js), so owner/team links, identity
//                             → account expansion, context members and activity actors all
//                             count, exactly as in the matrix filter
//   buildDetailQuery()        names of the first users of the result, for the sample
//
// The decisions (who is a member, under which term) are made in JS (principals.js).

import { likePattern } from './recipe.js';
import { normalizedSql, STATEMENT_TIMEOUT } from './matches.js';
import { orgConditionClause } from '../../matrix/orgCondition.js';
import { ENTITY_TEMPLATE_SQL } from '../../orgtruth/templates.js';

export const MAX_ORG_CANDIDATES = 500;
// Org entities per link statement: each one is its own orgConditionClause.
export const ORG_LINK_CHUNK = 50;
export const SAMPLE_SIZE = 200;

const NAME = normalizedSql('e."displayName"');

/**
 * Org entities a principal recipe may match. Term matching is limited to collection
 * entities of `orgTypes` (absent = every type); pinned ids are always loaded.
 * @returns {{ text: string, params: any[] }}
 */
export function buildOrgCandidateQuery(recipe, { limit = MAX_ORG_CANDIDATES } = {}) {
  const patterns = recipe.terms.filter(t => t.state === 'accepted').map(t => likePattern(t.key, t.match));
  // termScope: may the terms match this entity at all (a pinned entity is loaded either way).
  const termScope = `(${ENTITY_TEMPLATE_SQL('e')} = 'collection' AND ($1::text[] IS NULL OR e."entityType" = ANY($1::text[])))`;
  const text = `
    SELECT e."id", e."entityType", e."displayName", ${NAME} AS "f0", ${termScope} AS "termScope"
      FROM "OrgEntities" e
     WHERE e."status" = 'accepted' AND e."validTo" IS NULL
       AND ((${termScope} AND ${NAME} LIKE ANY($2::text[])) OR e."id" = ANY($3::uuid[]))
     ORDER BY e."displayName", e."id"
     LIMIT ${Number(limit) + 1}`;
  return { text, params: [recipe.orgTypes ?? null, patterns, [...recipe.orgInclude, ...recipe.orgExclude]] };
}

/** Assignments of the chosen types on the given resources, held by principals that exist. */
export function buildAccessQuery(resourceIds, assignmentTypes) {
  return {
    text: `
      SELECT DISTINCT ra."resourceId", ra."principalId", ra."assignmentType"
        FROM "ResourceAssignments" ra
        JOIN "Principals" p ON p."id" = ra."principalId" AND p."deletedAt" IS NULL
       WHERE ra."resourceId" = ANY($1::uuid[]) AND ra."assignmentType" = ANY($2::text[]) AND ra."deletedAt" IS NULL`,
    params: [resourceIds, assignmentTypes],
  };
}

/**
 * The principals linked to each of `entities` ({ id, entityType }), as (entityId,
 * principalId) rows: one orgConditionClause per entity, joined with UNION ALL.
 * @returns {{ text: string, params: any[] } | null}  null when there is nothing to ask
 */
export function buildOrgLinkQuery(entities) {
  const params = [];
  const bind = (value) => { params.push(value); return `$${params.length}`; };
  const parts = [];
  for (const e of entities) {
    const entityP = bind(e.id);
    const { clause } = orgConditionClause({
      entity: 'Principal', idExpr: 'p."id"', bind,
      cond: { kind: 'org', entityType: e.entityType, entityIds: [e.id] },
    });
    // A dropped condition (only possible for a malformed entity type) binds nothing more.
    if (clause) parts.push(`SELECT ${entityP}::uuid AS "entityId", p."id" AS "principalId" FROM "Principals" p WHERE p."deletedAt" IS NULL AND ${clause}`);
    else params.pop();
  }
  return parts.length ? { text: parts.join('\nUNION ALL\n'), params } : null;
}

/** The principals among `ids` that exist, as id rows. */
export function buildExistingQuery(ids) {
  return { text: `SELECT p."id" FROM "Principals" p WHERE p."id" = ANY($1::uuid[]) AND p."deletedAt" IS NULL`, params: [ids] };
}

/** The first `limit` of `ids` by name, with what the sample shows of them. */
export function buildDetailQuery(ids, limit = SAMPLE_SIZE) {
  return {
    text: `
      SELECT p."id", p."displayName", COALESCE(p."extendedAttributes"->>'userPrincipalName', p."email") AS "upn", p."principalType"
        FROM "Principals" p
       WHERE p."id" = ANY($1::uuid[])
       ORDER BY lower(p."displayName") NULLS LAST, p."id"
       LIMIT ${Number(limit)}`,
    params: [ids],
  };
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function runQuery(client, q) {
  return q ? (await client.query(q.text, q.params)).rows : [];
}

/** Read-only transaction with the recipe statement timeout. */
export async function readOnly(tx, work) {
  return tx(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return work(client);
  });
}

/** Org entities a principal recipe may match; see buildOrgCandidateQuery. */
export async function loadOrgCandidates(recipe, tx, { limit = MAX_ORG_CANDIDATES } = {}) {
  const rows = await readOnly(tx, client => runQuery(client, buildOrgCandidateQuery(recipe, { limit })));
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Everything the membership of a principal recipe is decided from.
 * @param {object}   recipe     a validated principal recipe
 * @param {string[]} resourceIds the resources the recipe holds (members + included)
 * @param {object[]} entities   the org entities to read links for ({ id, entityType })
 */
export async function loadPrincipalSources(recipe, resourceIds, entities, tx) {
  return readOnly(tx, async (client) => {
    const accessRows = resourceIds.length
      ? await runQuery(client, buildAccessQuery(resourceIds, recipe.access.assignmentTypes)) : [];
    const orgRows = [];
    for (const chunk of chunks(entities, ORG_LINK_CHUNK)) orgRows.push(...await runQuery(client, buildOrgLinkQuery(chunk)));
    const included = recipe.principalInclude.length
      ? (await runQuery(client, buildExistingQuery(recipe.principalInclude))).map(r => r.id) : [];
    return { accessRows, orgRows, included };
  });
}

/** Names of the first users of a result (see buildDetailQuery). */
export async function loadPrincipalDetails(ids, tx, limit = SAMPLE_SIZE) {
  if (!ids.length) return [];
  return readOnly(tx, client => runQuery(client, buildDetailQuery(ids, limit)));
}
