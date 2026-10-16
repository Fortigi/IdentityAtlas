// Organisation truth — the three queries both projection plugins read.
//
// The projection only ever sees *accepted* claims that are still *open*
// (validTo IS NULL): a proposed or rejected entity, relation or link never
// becomes a context or a member, and neither does a row a full run closed.
// A link an analyst rejected counts as rejected whatever its status says.
//
// 1. entities   every open, accepted entity (all types: the plugin filters, and
//               a relation may lead to an entity of a type that is not projected)
// 2. relations  every open, accepted relation (endpoints filtered in JS against 1)
// 3. links      every accepted link of an open, accepted entity, with Identity
//               links expanded to that identity's accounts (IdentityMembers,
//               minus the ones an analyst rejected) in `principalId`, one row per
//               account; `principalId` is null for every other target type.
//
// The WHERE clauses do the filtering; the status columns come back as well so
// project.js re-checks them (isLive) and a widened query can never leak a
// proposed or closed claim into a context.
import * as db from '../../db/connection.js';
import { ENTITY_TEMPLATE_SQL } from '../templates.js';

// Only collections become contexts: an enrichment row or a relation pair is
// information ABOUT things that exist, not a thing people and resources belong to.
export const COLLECTION_ONLY = `${ENTITY_TEMPLATE_SQL('e')} = 'collection'`;

export async function loadEntities() {
  return (await db.query(`
    SELECT e.id, e."entityType", e."displayName", e.attributes, e."sourceId", e."observedAt",
           e.status, e."validTo"
      FROM "OrgEntities" e
     WHERE e.status = 'accepted' AND e."validTo" IS NULL
       AND ${COLLECTION_ONLY}
     ORDER BY e."entityType", lower(e."displayName"), e.id
  `)).rows;
}

export async function loadRelations() {
  return (await db.query(`
    SELECT r."fromEntityId", r."toEntityId", r.status, r."validTo"
      FROM "OrgRelations" r
     WHERE r.status = 'accepted' AND r."validTo" IS NULL
  `)).rows;
}

export async function loadLinks() {
  return (await db.query(`
    SELECT l."orgEntityId" AS "entityId", l."targetType", l."targetId", l."via",
           l.status, l."analystOverride", im."principalId", im."analystOverride" AS "memberOverride"
      FROM "OrgLinks" l
      JOIN "OrgEntities" e ON e.id = l."orgEntityId"
      LEFT JOIN "IdentityMembers" im
             ON l."targetType" = 'Identity'
            AND im."identityId" = l."targetId"
            AND im."analystOverride" IS DISTINCT FROM 'rejected'
     WHERE l.status = 'accepted'
       AND l."analystOverride" IS DISTINCT FROM 'rejected'
       AND e.status = 'accepted' AND e."validTo" IS NULL
       AND ${COLLECTION_ONLY}
  `)).rows;
}

// All three, in one call; sequential so a mock can stage them in order.
export async function loadProjectionInput() {
  const entities = await loadEntities();
  const relations = await loadRelations();
  const links = await loadLinks();
  return { entities, relations, links };
}
