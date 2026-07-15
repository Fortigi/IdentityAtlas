import { Router } from 'express';
import { timedQuery } from '../perf/sqlTimer.js';
import { createParams } from '../db/sqlParams.js';
import { getResourceColumns, getResourceColumnValues } from '../db/columnCache.js';
import { ensureTagTables, buildFilterWhere } from './tags.js';
import { isMissingSchema } from '../db/schemaErrors.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const UUID_RE = /^[0-9a-f-]{36}$/i;
const SYSTEM_COLS = new Set(['SysStartTime', 'SysEndTime']);

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

function cleanRow(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row)) {
    if (!SYSTEM_COLS.has(key)) clean[key] = value;
  }
  return clean;
}

// Helper: parse tag string from SQL into array. Tag IDs are UUID strings (v6).
function parseTags(tagString) {
  if (!tagString) return [];
  return tagString.split('|').map(t => {
    const parts = t.split(':');
    return { id: parts[0], name: parts[1], color: parts[2] };
  });
}

async function getPermissionTable(_pool) {
  return '"vw_ResourceUserPermissionAssignments"';
}

// ─── GET /api/resources ─────────────────────────────────────────
// List resources with pagination, filtering, and search
router.get('/resources', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const search = (req.query.search || '').trim().slice(0, 200);
    const resourceType = (req.query.resourceType || '').trim();
    const systemId = (req.query.systemId || '').trim();
    const tagId = req.query.tagId ? String(req.query.tagId) : null;
    // Cap matches the bulk-list endpoints; UI defaults to 100, Power Query
    // walks in 1000-record pages.
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 10000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    // Parse attribute filters
    let attrFilters = {};
    if (req.query.filters) {
      try { attrFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
    }

    // Extract virtual tag filter before column validation
    let resourceTagFilter = null;
    if (attrFilters['__resourceTag']) {
      resourceTagFilter = String(attrFilters['__resourceTag']);
      delete attrFilters['__resourceTag'];
    }
    // Backward compat: also accept __groupTag
    if (!resourceTagFilter && attrFilters['__groupTag']) {
      resourceTagFilter = String(attrFilters['__groupTag']);
      delete attrFilters['__groupTag'];
    }

    const p = await db.getPool();
    await ensureTagTables(p);

    const { params, bind } = createParams();

    // Validate attribute filters against actual columns
    const cols = await getResourceColumns(p);
    const colNames = new Set(cols.map(c => c.name));

    let where = '1=1';
    // Hide soft-deleted resources by default; ?includeDeleted=true reveals them.
    if (req.query.includeDeleted !== 'true') where += ` AND r."deletedAt" IS NULL`;
    if (search) {
      const s = bind(`%${search}%`);
      where += ` AND (r."displayName" ILIKE ${s} OR r."description" ILIKE ${s})`;
    }
    if (resourceType) {
      where += ` AND r."resourceType" = ${bind(resourceType)}`;
    } else if (req.query.includeBusinessRoles !== 'true') {
      // The UI grid lists actual-access resources only; business roles /
      // access packages live on the governance (SOLL) side and are hidden by
      // default. The Excel export passes ?includeBusinessRoles=true so an
      // analyst can rebuild the governance matrix — joining a BusinessRole's
      // `Contains` relationships to the groups it grants — entirely in Excel.
      where += ` AND (r."resourceType" IS NULL OR r."resourceType" <> 'BusinessRole')`;
    }
    if (systemId && /^\d+$/.test(systemId)) {
      where += ` AND r."systemId" = ${bind(parseInt(systemId, 10))}`;
    }
    if (tagId) {
      where += ` AND EXISTS (
        SELECT 1 FROM "GraphTagAssignments" ta
        INNER JOIN "GraphTags" t ON ta."tagId" = t.id
        WHERE ta."tagId" = ${bind(tagId)} AND ta."entityId" = UPPER(r.id::text)
          AND t."entityType" IN ('resource', 'group')
      )`;
    }

    let resourceTagJoin = '';
    if (resourceTagFilter) {
      resourceTagJoin = `
        INNER JOIN "GraphTagAssignments" _rta ON _rta."entityId" = UPPER(r.id::text)
        INNER JOIN "GraphTags" _rt ON _rta."tagId" = _rt.id AND _rt."name" = ${bind(resourceTagFilter)} AND _rt."entityType" IN ('resource', 'group')`;
    }
    where += buildFilterWhere(attrFilters, colNames, 'r', bind);

    // Returns every Resources column so the same endpoint feeds the UI grid
    // AND the Power Query Excel export (which auto-expands extendedAttributes
    // into first-class ext_* columns). The UI ignores fields it doesn't need.
    // Page first, then resolve tags only for the page rows; count only on page 1.
    // (Same export-pagination fix as /api/users — the per-row tag subquery used to
    // run for every offset+limit row before OFFSET discarded the first `offset`,
    // quadratic across an export and slow enough to time out a deep page.)
    // pg can't run a multi-statement query with bound params, so the data and
    // COUNT statements run separately (count only on page 1). Snapshot the filter
    // params before binding the page window so the COUNT query isn't handed the
    // LIMIT/OFFSET values it never references.
    const countParams = [...params];
    const baseSql = `
      WITH page AS (
        SELECT r.id, r."displayName", r."description", r."resourceType", r."governanceResource",
               r."systemId", r."enabled",
               r."createdDateTime", r."extendedAttributes",
               r."mail", r."visibility", r."externalId",
               r."catalogId", r."isHidden", r."modifiedDateTime",
               r."riskScore", r."riskTier", r."deletedAt"
          FROM "Resources" r
          ${resourceTagJoin}
         WHERE ${where}
         ORDER BY r."displayName"
         LIMIT ${bind(limit)} OFFSET ${bind(offset)}
      )
      SELECT page.*,
             (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
                FROM "GraphTagAssignments" ta
                INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" IN ('resource', 'group')
               WHERE ta."entityId" = UPPER(page.id::text)
             ) AS "tagString"
        FROM page
       ORDER BY page."displayName"`;
    const dataResult = await db.query(baseSql, params);

    const data = dataResult.rows.map(row => {
      const { tagString, extendedAttributes, ...rest } = row;
      // jsonb columns come back already-parsed from pg
      const parsedExtAttrs = extendedAttributes && typeof extendedAttributes === 'string'
        ? (() => { try { return JSON.parse(extendedAttributes); } catch { return null; } })()
        : extendedAttributes;
      return {
        ...rest,
        extendedAttributes: parsedExtAttrs,
        tags: parseTags(tagString),
        // backward compat aliases
        groupId: row.id,
        groupDisplayName: row.displayName,
        groupDescription: row.description,
        groupTypeCalculated: row.resourceType,
      };
    });

    let total = null;
    if (offset === 0) {
      const countSql = `SELECT COUNT(*)::int AS total FROM "Resources" r ${resourceTagJoin} WHERE ${where}`;
      total = (await db.query(countSql, countParams)).rows[0]?.total ?? null;
    }

    res.json({ data, total });
  } catch (err) {
    console.error('GET /resources failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/resources/:id ─────────────────────────────────────
// Get single resource with attributes, tags, counts
router.get('/resources/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: {}, tags: [], memberCount: 0, accessPackageCount: 0, hasHistory: false });
  try {
    const pool = await db.getPool();
    const resourceId = req.params.id;

    // 1. Current attributes
    const resourceResult = await timedQuery(pool, 'resource-attributes', res,
      `SELECT * FROM "Resources" WHERE id = $1`, [resourceId]);

    if (resourceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    const attributes = cleanRow(resourceResult.rows[0]);

    // Parse extendedAttributes JSON
    if (attributes.extendedAttributes) {
      try {
        attributes.extendedAttributesParsed = JSON.parse(attributes.extendedAttributes);
      } catch { /* ignore bad JSON */ }
    }

    // 1b. Risk score — stored in RiskScores keyed by (entityId, entityType).
    //     Merge it onto attributes so the detail page's Risk tab can render.
    try {
      const rs = await db.query(
        `SELECT "riskScore", "riskTier", "riskDirectScore", "riskMembershipScore",
                "riskStructuralScore", "riskPropagatedScore", "riskExplanation",
                "riskClassifierMatches", "riskOverride", "riskOverrideReason", "riskScoredAt"
           FROM "RiskScores"
          WHERE "entityId"::text = $1 AND "entityType" = 'Resource'
          LIMIT 1`,
        [resourceId]
      );
      if (rs.rows.length > 0) Object.assign(attributes, cleanRow(rs.rows[0]));
    } catch (e) { if (!isMissingSchema(e)) throw e; /* RiskScores may not exist on older deployments */ }

    // 2. Tags (support both 'resource' and 'group' entity types for backward compat)
    let tags = [];
    try {
      const r = await timedQuery(pool, 'resource-tags', res, `
          SELECT t.id, t.name, t.color
          FROM "GraphTagAssignments" ta
          JOIN "GraphTags" t ON ta."tagId" = t.id
          WHERE ta."entityId" = $1 AND t."entityType" IN ('resource', 'group')
        `, [resourceId]);
      tags = r.rows;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 3. Member count — broken down by the universal assignmentType so the entity
    //    graph can show a node per type (Direct / Indirect / Eligible). governed is
    //    a flag on a Direct assignment, not a type of its own, so a governed grant
    //    counts as Direct (its governed-ness shows on the assignment, not here);
    //    Owner is retired (ownership is its own GroupOwnership resource).
    let memberCount = 0;
    const assignmentByType = { Direct: 0, Indirect: 0, Eligible: 0 };
    try {
      const r = await timedQuery(pool, 'resource-member-breakdown', res, `
          SELECT "assignmentType",
                 COUNT(DISTINCT "principalId")::int AS cnt
          FROM "ResourceAssignments"
          WHERE "resourceId" = $1
          GROUP BY "assignmentType"
        `, [resourceId]);
      for (const row of r.rows) {
        if (row.assignmentType in assignmentByType) assignmentByType[row.assignmentType] = row.cnt;
      }
      memberCount = Object.values(assignmentByType).reduce((a, b) => a + b, 0);
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
      // Fall back to permission view (no type breakdown there — leave counts 0)
      try {
        const table = await getPermissionTable(pool);
        const r = await timedQuery(pool, 'resource-member-count-view', res,
          `SELECT COUNT(DISTINCT "memberId") AS cnt FROM ${table} WHERE "resourceId" = $1`, [resourceId]);
        memberCount = r.rows[0].cnt;
      } catch (e) { if (!isMissingSchema(e)) throw e; /* view may not exist */ }
    }

    // 4. Access package count (business roles that contain this resource)
    let accessPackageCount = 0;
    try {
      const r = await timedQuery(pool, 'resource-ap-count', res, `
          SELECT COUNT(DISTINCT rrs."parentResourceId") AS cnt
          FROM "ResourceRelationships" rrs
          INNER JOIN "Resources" br ON rrs."parentResourceId" = br.id AND br."resourceType" = 'BusinessRole'
          WHERE rrs."childResourceId" = $1
            AND rrs."relationshipType" = 'Contains'
            AND rrs."parentResourceId" IS NOT NULL
        `, [resourceId]);
      accessPackageCount = r.rows[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 4b. Parent resource count (all parent resources via any relationship type)
    let parentResourceCount = 0;
    try {
      const r = await timedQuery(pool, 'resource-parent-count', res, `
          SELECT COUNT(DISTINCT rrs."parentResourceId") AS cnt
          FROM "ResourceRelationships" rrs
          WHERE rrs."childResourceId" = $1
        `, [resourceId]);
      parentResourceCount = r.rows[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 5. History count (v5: queries the _history audit table)
    let historyCount = 0;
    try {
      const r = await db.queryOne(
        `SELECT COUNT(*)::int AS cnt FROM "_history" WHERE "tableName" = 'Resources' AND "rowId" = $1`,
        [resourceId]
      );
      historyCount = r?.cnt ?? 0;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* _history may not exist on older deployments */ }

    // 6. Context-membership count (v6 — Resources.contextId column was
    // dropped in favor of the many-to-many ContextMembers join).
    let contextCount = 0;
    try {
      const r = await db.queryOne(
        `SELECT COUNT(*)::int AS cnt FROM "ContextMembers" WHERE "memberId"::text = $1`,
        [resourceId]
      );
      contextCount = r?.cnt ?? 0;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* ContextMembers may not exist on older deployments */ }

    res.json({ attributes, tags, memberCount, assignmentByType, accessPackageCount, parentResourceCount, historyCount, hasHistory: historyCount > 0, contextCount });
  } catch (err) {
    console.error('Error fetching resource detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch resource details' });
  }
});

// ─── GET /api/resources/:id/contexts ────────────────────────────
// Lazy-loaded list of contexts this resource is a member of (v6).
router.get('/resources/:id/contexts', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const rows = (await db.query(
      `SELECT c.id, c."displayName", c."contextType", c."targetType", c.variant
         FROM "ContextMembers" cm
         JOIN "Contexts" c ON c.id = cm."contextId"
        WHERE cm."memberId"::text = $1
        ORDER BY c."contextType", c."displayName"`,
      [req.params.id]
    )).rows;
    res.json(rows);
  } catch (err) {
    console.error('GET /resources/:id/contexts failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch resource contexts' });
  }
});

// ─── GET /api/resources/:id/assignments ─────────────────────────
// Get principals assigned to this resource, with assignment type
router.get('/resources/:id/assignments', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedQuery(pool, 'resource-assignments', res, `
        SELECT ra."principalId", p."displayName" AS "principalDisplayName", p.email,
               p."principalType", ra."assignmentType", ra.state, ra."assignmentStatus"
        FROM "ResourceAssignments" ra
        LEFT JOIN "Principals" p ON ra."principalId" = p.id
        WHERE ra."resourceId" = $1
        ORDER BY ra."assignmentType", p."displayName"
      `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching resource assignments:', err.message);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ─── GET /api/resources/:id/business-roles ──────────────────────
// Get business roles that contain this resource (via ResourceRelationships)
router.get('/resources/:id/business-roles', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedQuery(pool, 'resource-business-roles', res, `
        SELECT DISTINCT rr."parentResourceId" AS "businessRoleId", br."displayName" AS "businessRoleName",
               rr."roleName", rr."relationshipType"
        FROM "ResourceRelationships" rr
        INNER JOIN "Resources" br ON rr."parentResourceId" = br.id
          AND br."resourceType" = 'BusinessRole'
        WHERE rr."childResourceId" = $1 AND rr."relationshipType" = 'Contains'
          AND rr."parentResourceId" IS NOT NULL
        ORDER BY br."displayName"
      `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching business roles:', err.message);
    res.status(500).json({ error: 'Failed to fetch business roles' });
  }
});

// ─── GET /api/resources/:id/parent-resources ────────────────────
// Get resources this resource is a member/child of (via ResourceRelationships)
router.get('/resources/:id/parent-resources', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedQuery(pool, 'resource-parents', res, `
        SELECT rr."parentResourceId", pr."displayName" AS "parentDisplayName",
               pr."resourceType" AS "parentResourceType", rr."relationshipType", rr."roleName"
        FROM "ResourceRelationships" rr
        INNER JOIN "Resources" pr ON rr."parentResourceId" = pr.id
        WHERE rr."childResourceId" = $1
        ORDER BY rr."relationshipType", pr."displayName"
      `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching parent resources:', err.message);
    res.status(500).json({ error: 'Failed to fetch parent resources' });
  }
});

// ─── GET /api/resources/:id/members ─────────────────────────────
// Legacy: Get resource members via materialized permission view
router.get('/resources/:id/members', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const table = await getPermissionTable(pool);
    const r = await timedQuery(pool, 'resource-members', res, `
        SELECT p."resourceId", p."principalId" AS "memberId",
               u."displayName" AS "memberDisplayName", u."email" AS "memberUPN",
               p."membershipType", p."managedByAccessPackage", false AS "deleted"
          FROM ${table} p
          LEFT JOIN "Principals" u ON p."principalId" = u.id
         WHERE p."resourceId"::text = $1
        UNION ALL
        -- Historical holders: the assignment or the holder is soft-deleted, so the
        -- matview hid it. Surface them flagged so the resource keeps its history.
        SELECT ra."resourceId", ra."principalId" AS "memberId",
               u."displayName" AS "memberDisplayName", u."email" AS "memberUPN",
               ra."assignmentType" AS "membershipType", false AS "managedByAccessPackage", true AS "deleted"
          FROM "ResourceAssignments" ra
          JOIN "Principals" u ON u.id = ra."principalId"
         WHERE ra."resourceId"::text = $1
           AND ra."principalId" IS NOT NULL
           AND (ra."deletedAt" IS NOT NULL OR u."deletedAt" IS NOT NULL)
         ORDER BY "memberDisplayName", "membershipType"
      `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching resource members:', err.message);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// ─── GET /api/resources/:id/history ─────────────────────────────
// Version history from the v5 `_history` audit table.
router.get('/resources/:id/history', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const r = await db.query(
      `SELECT operation, "changedAt", "rowData"
         FROM "_history"
        WHERE "tableName" = 'Resources' AND "rowId" = $1
        ORDER BY "changedAt" DESC`,
      [req.params.id]
    );
    const rows = r.rows.map((row, idx) => ({
      ...(row.rowData || {}),
      ValidFrom: row.changedAt,
      ValidTo: idx > 0 ? r.rows[idx - 1].changedAt : null,
      _operation: row.operation,
    }));
    res.json(rows.map(cleanRow));
  } catch (err) {
    console.error('resource-history failed:', err.message);
    res.json([]);
  }
});

// ─── GET /api/resource-columns ──────────────────────────────────
// Column discovery for the Resources page (distinct values from Resources table)
router.get('/resource-columns', async (req, res) => {
  const schemaOnly = req.query.schema === 'true';
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();

    let grouped;
    if (schemaOnly) {
      const cols = await getResourceColumns(p);
      grouped = Object.fromEntries(cols.map(c => [c.name, []]));
    } else {
      grouped = { ...await getResourceColumnValues(p) };
    }

    // Add virtual __resourceTag column (tag names as values)
    try {
      await ensureTagTables(p);
      const tagResult = await db.query(`
        SELECT t.name
        FROM "GraphTags" t
        WHERE t."entityType" IN ('resource', 'group')
          AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
        ORDER BY t.name
      `);
      const resourceTags = tagResult.rows.map(r => r.name);
      grouped['__resourceTag'] = schemaOnly ? [] : resourceTags;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* tag tables may not exist yet */ }

    return res.json(Object.entries(grouped).map(([column, values]) => ({ column, values })));
  } catch (err) {
    console.error('resource-columns query failed:', err.message);
    return res.json([]);
  }
});

export default router;
