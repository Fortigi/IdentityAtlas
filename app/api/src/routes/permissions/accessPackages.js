// Access-package → resource mapping endpoints — /api/access-package-groups and
// its /api/access-package-resources alias.
//
// Extracted verbatim from routes/permissions.js (audit finding C1). Mounted by
// routes/permissions.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { ensureCategoryTables } from '../categories.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { useSql, db } from './shared.js';

const router = Router();

// GET /api/access-package-groups - Access package to group/resource mapping
// Also aliased as /api/access-package-resources
router.get('/access-package-groups', accessPackageResourcesHandler);
router.get('/access-package-resources', accessPackageResourcesHandler);

// Flatten the grouped (AP → resources[]) rows into the legacy (AP, resource)
// row shape — one null-resource row for an AP with no resources.
function flattenAccessPackageRows(rows) {
  const flat = [];
  for (const row of rows) {
    const base = {
      accessPackageId:   row.accessPackageId,
      businessRoleId:    row.businessRoleId,
      accessPackageName: row.accessPackageName,
      systemId:          row.systemId,
      catalogName:       row.catalogName,
      totalAssignments:  row.totalAssignments,
      categoryId:        row.categoryId,
      categoryName:      row.categoryName,
      categoryColor:     row.categoryColor,
    };
    const resources = Array.isArray(row.resources) ? row.resources : [];
    if (resources.length === 0) {
      flat.push({ ...base, resourceId: null, groupId: null, resourceName: null, groupName: null, resourceType: null, roleName: null });
      continue;
    }
    for (const r of resources) flat.push({ ...base, ...r });
  }
  return flat;
}

async function accessPackageResourcesHandler(req, res) {
  try {
    if (useSql) {
      const p = await db.getPool();
      try { await ensureCategoryTables(p); } catch (e) { if (!isMissingSchema(e)) throw e; /* category tables optional */ }
      // Performance notes:
      //  - Previous version returned one row per (AP, resource) pair and
      //    let Node de-normalize it. On the load-test dataset that was
      //    ~100k rows × 15 columns → 30 MB of JSON and ~15 s in Express
      //    serialization alone, even though the SQL itself was ~2 s.
      //  - We now aggregate server-side into one row per AP with a
      //    json_agg'd array of resources. Same data, ~100× fewer rows,
      //    ~100× less JSON work in Node.
      //  - The client side is responsible for flattening if it needs a
      //    (ap, resource) row shape — most callers want the grouped view.
      const result = await timedQuery(p, 'ap-groups', res, `
        WITH ac AS (
          SELECT "resourceId", COUNT(*)::int AS cnt
            FROM "ResourceAssignments"
           WHERE ("state" = 'delivered' OR "state" IS NULL)
             AND "governed" = true
           GROUP BY "resourceId"
        )
        SELECT
          ap.id                            AS "accessPackageId",
          ap.id                            AS "businessRoleId",
          ap."displayName"                 AS "accessPackageName",
          ap."systemId"                    AS "systemId",
          c."displayName"                  AS "catalogName",
          COALESCE(ac.cnt, 0)              AS "totalAssignments",
          cat.id                           AS "categoryId",
          cat."name"                       AS "categoryName",
          cat."color"                      AS "categoryColor",
          COALESCE(
            json_agg(
              json_build_object(
                'resourceId',   rrs."childResourceId",
                'groupId',      rrs."childResourceId",
                'resourceName', r."displayName",
                'groupName',    r."displayName",
                'resourceType', r."resourceType",
                'systemId',     r."systemId",
                'roleName',     rrs."roleName"
              )
              ORDER BY r."displayName"
            ) FILTER (WHERE rrs."childResourceId" IS NOT NULL),
            '[]'::json
          ) AS resources
        FROM "Resources" ap
        LEFT JOIN "ResourceRelationships" rrs
               ON rrs."parentResourceId" = ap.id
              AND rrs."relationshipType" = 'Contains'
        LEFT JOIN "Resources" r ON rrs."childResourceId" = r.id
        LEFT JOIN "GovernanceCatalogs" c ON ap."catalogId" = c.id
        LEFT JOIN ac ON ac."resourceId" = ap.id
        LEFT JOIN "GovernanceCategoryAssignments" ca ON ap.id::text = ca."resourceId"
        LEFT JOIN "GovernanceCategories" cat ON ca."categoryId" = cat.id
        WHERE ap."resourceType" = 'BusinessRole'
        GROUP BY ap.id, ap."displayName", ap."systemId", c."displayName",
                 ac.cnt, cat.id, cat."name", cat."color"
        ORDER BY ap."displayName"
      `, []);

      // Callers historically expected a flat (ap, resource) shape. Flatten
      // on the Node side — cheap because postgres already did the join.
      return res.json(flattenAccessPackageRows(result.rows));
    }
    res.json([]);
  } catch (err) {
    // Table may not exist in this environment — return empty instead of 500
    console.error('access-package-groups query failed:', err.message);
    res.json([]);
  }
}

export default router;
