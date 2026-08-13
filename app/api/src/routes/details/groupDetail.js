// Phase helpers for GET /api/group/:id, extracted from details/group.js so the
// handler stays under the complexity threshold. Each fetch keeps
// its own try/catch (swallow a missing optional table, rethrow otherwise).
// Covered through details.test.js + groupDetail.contract.test.js. SQL verbatim.

import { timedQuery } from '../../perf/sqlTimer.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { cleanRow, getPermissionTable, countHistory } from './shared.js';

// 1. Current attributes from Resources (+ parsed extendedAttributes). Returns
//    null when the group doesn't exist (handler → 404).
export async function fetchGroupAttributes(pool, res, groupId) {
  const groupResult = await timedQuery(pool, 'group-attributes', res,
    `SELECT * FROM "Resources" WHERE id = $1`, [groupId]);
  if (groupResult.rows.length === 0) return null;
  const attributes = cleanRow(groupResult.rows[0]);
  if (attributes.extendedAttributes) {
    attributes.extendedAttributesParsed = parseJsonbColumn(attributes.extendedAttributes);
  }
  return attributes;
}

// 2. Tags (both 'resource' and 'group' entity types).
export async function fetchGroupTags(pool, res, groupId) {
  try {
    const r = await timedQuery(pool, 'group-tags', res, `
      SELECT t.id, t.name, t.color
      FROM "GraphTagAssignments" ta
      JOIN "GraphTags" t ON ta."tagId" = t.id
      WHERE ta."entityId" = UPPER($1) AND t."entityType" IN ('resource', 'group')
    `, [groupId]);
    return r.rows;
  } catch (e) { if (!isMissingSchema(e)) throw e; return []; /* table may not exist */ }
}

// 3. Member count from the permission view (keyed by principalId).
export async function fetchGroupMemberCount(pool, res, groupId) {
  try {
    const table = await getPermissionTable(pool);
    const r = await timedQuery(pool, 'group-member-count', res,
      `SELECT COUNT(DISTINCT "principalId")::int AS cnt FROM ${table} WHERE "resourceId" = $1`, [groupId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* view may not exist */ }
}

// 4. Access-package count (business roles that contain this group).
export async function fetchGroupAccessPackageCount(pool, res, groupId) {
  try {
    const r = await timedQuery(pool, 'group-ap-count', res, `
      SELECT COUNT(DISTINCT rrs."parentResourceId")::int AS cnt
      FROM "ResourceRelationships" rrs
      WHERE UPPER(rrs."childResourceId"::text) = UPPER($1)
        AND rrs."relationshipType" = 'Contains'
    `, [groupId]);
    return r.rows[0].cnt;
  } catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* table may not exist */ }
}

// 5. History count (v5: the _history audit table).
export async function fetchGroupHistoryCount(groupId) {
  try { return await countHistory('Resources', groupId); }
  catch (e) { if (!isMissingSchema(e)) throw e; return 0; /* _history may not exist on older deployments */ }
}
