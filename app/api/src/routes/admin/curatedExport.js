// Export-side helpers for GET /api/admin/export/curated, extracted from
// admin/curatedData.js so the handler stays under the complexity threshold
// (it was cognitive 20). The row-grouping is pure and unit-tested directly in
// curatedData.helpers.test.js; the SQL is moved verbatim.

import * as db from '../../db/connection.js';

// Postgres: use to_regclass() (returns NULL when the table doesn't exist).
export async function tableExists(_pool, tableName) {
  const r = await db.query(
    `SELECT to_regclass($1) AS oid`,
    ['"' + tableName + '"']
  );
  return r.rows[0].oid !== null;
}

// Pure: group the flat tag/assignment rows into tag objects with assignments.
export function groupExportTags(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = String(row.id);
    if (!byId.has(key)) {
      byId.set(key, { name: row.name, color: row.color, entityType: row.entityType, assignments: [] });
    }
    if (row.entityId) {
      byId.get(key).assignments.push({
        entityId:    row.entityId,
        displayName: row.entityDisplayName || null,
        resourceType: row.resourceType || null,
      });
    }
  }
  return Array.from(byId.values());
}

// Pure: group the flat category/AP-assignment rows into category objects.
export function groupExportCategories(rows) {
  const byCatId = new Map();
  for (const row of rows) {
    const key = String(row.id);
    if (!byCatId.has(key)) {
      byCatId.set(key, { name: row.name, color: row.color, assignments: [] });
    }
    if (row.resourceId) {
      byCatId.get(key).assignments.push({
        accessPackageId:          row.resourceId,
        accessPackageDisplayName: row.businessRoleDisplayName || null,
      });
    }
  }
  return Array.from(byCatId.values());
}

// Tags + assignments. entityIds are stored as text; cast to uuid only when the
// value is uuid-shaped, otherwise the cast errors and breaks the whole query.
export async function fetchExportTags(pool) {
  if (!(await tableExists(pool, 'GraphTags'))) return [];
  const userJoin = `LEFT JOIN "Principals" gu ON t."entityType" = 'user'
         AND ta."entityId" ~* '^[0-9a-f-]{36}$'
         AND gu.id = ta."entityId"::uuid`;
  const resourceJoin = `LEFT JOIN "Resources" r ON t."entityType" IN ('resource','group')
         AND ta."entityId" ~* '^[0-9a-f-]{36}$'
         AND r.id = ta."entityId"::uuid`;

  const tagRows = await db.query(`
    SELECT t.id, t.name, t.color, t."entityType",
           ta."entityId",
           COALESCE(gu."displayName", r."displayName") AS "entityDisplayName",
           r."resourceType" AS "resourceType"
    FROM "GraphTags" t
    LEFT JOIN "GraphTagAssignments" ta ON ta."tagId" = t.id
    ${userJoin}
    ${resourceJoin}
    ORDER BY t."entityType", t.name, ta."entityId"
  `);
  return groupExportTags(tagRows.rows);
}

// Categories + AP assignments.
export async function fetchExportCategories(pool) {
  if (!(await tableExists(pool, 'GovernanceCategories'))) return [];
  const catRows = await db.query(`
    SELECT c.id, c.name, c.color, ca."resourceId", ap."displayName" AS "businessRoleDisplayName"
    FROM "GovernanceCategories" c
    LEFT JOIN "GovernanceCategoryAssignments" ca ON ca."categoryId" = c.id
    LEFT JOIN "Resources" ap
      ON LOWER(ap.id::text) = LOWER(ca."resourceId")
      AND ap."resourceType" = 'BusinessRole'
    ORDER BY c.name, ca."resourceId"
  `);
  return groupExportCategories(catRows.rows);
}
