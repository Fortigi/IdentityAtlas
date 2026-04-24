import { Router } from 'express';
import { timedRequest } from '../perf/sqlTimer.js';
import { getResourceColumns, getResourceColumnValues, FILTERABLE_TYPES } from '../db/columnCache.js';
import { ensureTagTables, buildFilterWhere } from './tags.js';

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

    // Extract virtual system name filter (filters via joined Systems table)
    let systemNameFilter = null;
    if (attrFilters['__systemName']) {
      systemNameFilter = String(attrFilters['__systemName']);
      delete attrFilters['__systemName'];
    }

    const p = await db.getPool();
    await ensureTagTables(p);

    const request = p.request();
    request.input('limit', limit);
    request.input('offset', offset);

    // Validate attribute filters against actual columns
    const cols = await getResourceColumns(p);
    const colNames = new Set(cols.map(c => c.name));

    const filterWhere = buildFilterWhere(request, attrFilters, colNames, 'r');

    let where = '1=1';
    if (search) {
      where += ` AND (r."displayName" ILIKE @search OR r."description" ILIKE @search)`;
      request.input('search', `%${search}%`);
    }
    if (resourceType) {
      where += ` AND r."resourceType" = @resourceType`;
      request.input('resourceType', resourceType);
    } else {
      where += ` AND (r."resourceType" IS NULL OR r."resourceType" <> 'BusinessRole')`;
    }
    if (systemId && /^\d+$/.test(systemId)) {
      where += ` AND r."systemId" = @systemId`;
      request.input('systemId', parseInt(systemId, 10));
    }
    if (tagId) {
      where += ` AND EXISTS (
        SELECT 1 FROM "GraphTagAssignments" ta
        INNER JOIN "GraphTags" t ON ta."tagId" = t.id
        WHERE ta."tagId" = @tagId AND ta."entityId" = UPPER(r.id::text)
          AND t."entityType" IN ('resource', 'group')
      )`;
      request.input('tagId', tagId);
    }

    let resourceTagJoin = '';
    if (resourceTagFilter) {
      resourceTagJoin = `
        INNER JOIN "GraphTagAssignments" _rta ON _rta."entityId" = UPPER(r.id::text)
        INNER JOIN "GraphTags" _rt ON _rta."tagId" = _rt.id AND _rt."name" = @__resourceTag AND _rt."entityType" IN ('resource', 'group')`;
      request.input('__resourceTag', resourceTagFilter);
    }
    where += filterWhere;
    if (systemNameFilter) {
      where += ` AND s."displayName" = @__systemName`;
      request.input('__systemName', systemNameFilter);
    }

    // Returns every Resources column so the same endpoint feeds the UI grid
    // AND the Power Query Excel export (which auto-expands extendedAttributes
    // into first-class ext_* columns). The UI ignores fields it doesn't need.
    const result = await request.query(`
      SELECT r.id, r."displayName", r."description", r."resourceType", r."systemId", r."enabled",
             r."createdDateTime", r."extendedAttributes",
             r."mail", r."visibility", r."externalId",
             r."catalogId", r."isHidden", r."modifiedDateTime",
             r."riskScore", r."riskTier",
             s."displayName" AS "systemName",
             (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
                FROM "GraphTagAssignments" ta
                INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" IN ('resource', 'group')
               WHERE ta."entityId" = UPPER(r.id::text)
             ) AS "tagString",
             (SELECT COALESCE(rp."displayName", rr."parentResourceId"::text)
                FROM "ResourceRelationships" rr
                LEFT JOIN "Resources" rp ON rp.id = rr."parentResourceId"
               WHERE rr."childResourceId" = r.id AND rr."relationshipType" = 'Contains'
               LIMIT 1
             ) AS "parentDisplayName"
        FROM "Resources" r
        LEFT JOIN "Systems" s ON s.id = r."systemId"
        ${resourceTagJoin}
       WHERE ${where}
       ORDER BY r."displayName"
       LIMIT @limit OFFSET @offset;

      SELECT COUNT(*)::int AS total FROM "Resources" r
        ${systemNameFilter ? 'LEFT JOIN "Systems" s ON s.id = r."systemId"' : ''}
        ${resourceTagJoin} WHERE ${where};
    `);

    const data = result.recordsets[0].map(row => {
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

    res.json({ data, total: result.recordsets[1][0].total });
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
    const resourceResult = await timedRequest(pool, 'resource-attributes', res)
      .input('id', resourceId)
      .query(`
        SELECT r.*, s."displayName" AS "systemName"
        FROM "Resources" r
        LEFT JOIN "Systems" s ON s.id = r."systemId"
        WHERE r.id = @id
      `);

    if (resourceResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    const attributes = cleanRow(resourceResult.recordset[0]);

    // Parse extendedAttributes JSON
    if (attributes.extendedAttributes) {
      try {
        attributes.extendedAttributesParsed = JSON.parse(attributes.extendedAttributes);
      } catch { /* ignore bad JSON */ }
    }

    // 2. Tags (support both 'resource' and 'group' entity types for backward compat)
    let tags = [];
    try {
      const r = await timedRequest(pool, 'resource-tags', res)
        .input('id', resourceId)
        .query(`
          SELECT t.id, t.name, t.color
          FROM "GraphTagAssignments" ta
          JOIN "GraphTags" t ON ta."tagId" = t.id
          WHERE ta."entityId" = @id AND t."entityType" IN ('resource', 'group')
        `);
      tags = r.recordset;
    } catch { /* table may not exist */ }

    // 3. Member count — broken down by assignmentType so the entity graph
    //    can show a node per type (Direct / Governed / Owner / Eligible).
    let memberCount = 0;
    const assignmentByType = { Direct: 0, Governed: 0, Owner: 0, Eligible: 0 };
    try {
      const r = await timedRequest(pool, 'resource-member-breakdown', res)
        .input('id', resourceId)
        .query(`
          SELECT "assignmentType", COUNT(DISTINCT "principalId")::int AS cnt
          FROM "ResourceAssignments"
          WHERE "resourceId" = @id
          GROUP BY "assignmentType"
        `);
      for (const row of r.recordset) {
        if (row.assignmentType in assignmentByType) assignmentByType[row.assignmentType] = row.cnt;
      }
      memberCount = Object.values(assignmentByType).reduce((a, b) => a + b, 0);
    } catch {
      // Fall back to permission view (no type breakdown there — leave counts 0)
      try {
        const table = await getPermissionTable(pool);
        const r = await timedRequest(pool, 'resource-member-count-view', res)
          .input('id', resourceId)
          .query(`SELECT COUNT(DISTINCT "memberId") AS cnt FROM ${table} WHERE "resourceId" = @id`);
        memberCount = r.recordset[0].cnt;
      } catch { /* view may not exist */ }
    }

    // 4. Access package count (business roles that contain this resource)
    let accessPackageCount = 0;
    try {
      const r = await timedRequest(pool, 'resource-ap-count', res)
        .input('id', resourceId)
        .query(`
          SELECT COUNT(DISTINCT rrs."parentResourceId") AS cnt
          FROM "ResourceRelationships" rrs
          INNER JOIN "Resources" br ON rrs."parentResourceId" = br.id AND br."resourceType" = 'BusinessRole'
          WHERE rrs."childResourceId" = @id
            AND rrs."relationshipType" = 'Contains'
            AND rrs."parentResourceId" IS NOT NULL
        `);
      accessPackageCount = r.recordset[0].cnt;
    } catch { /* table may not exist */ }

    // 4b. Parent resource count (all parent resources via any relationship type)
    let parentResourceCount = 0;
    try {
      const r = await timedRequest(pool, 'resource-parent-count', res)
        .input('id', resourceId)
        .query(`
          SELECT COUNT(DISTINCT rrs."parentResourceId") AS cnt
          FROM "ResourceRelationships" rrs
          WHERE rrs."childResourceId" = @id
        `);
      parentResourceCount = r.recordset[0].cnt;
    } catch { /* table may not exist */ }

    // 5. History count (v5: queries the _history audit table)
    let historyCount = 0;
    try {
      const r = await db.queryOne(
        `SELECT COUNT(*)::int AS cnt FROM "_history" WHERE "tableName" = 'Resources' AND "rowId" = $1`,
        [resourceId]
      );
      historyCount = r?.cnt ?? 0;
    } catch { /* _history may not exist on older deployments */ }

    // 6. Context-membership count (v6 — Resources.contextId column was
    // dropped in favor of the many-to-many ContextMembers join).
    let contextCount = 0;
    try {
      const r = await db.queryOne(
        `SELECT COUNT(*)::int AS cnt FROM "ContextMembers" WHERE "memberId"::text = $1`,
        [resourceId]
      );
      contextCount = r?.cnt ?? 0;
    } catch { /* ContextMembers may not exist on older deployments */ }

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
    const r = await timedRequest(pool, 'resource-assignments', res)
      .input('id', req.params.id)
      .query(`
        SELECT ra."principalId", p."displayName" AS "principalDisplayName", p.email,
               p."principalType", ra."assignmentType", ra.state, ra."assignmentStatus"
        FROM "ResourceAssignments" ra
        LEFT JOIN "Principals" p ON ra."principalId" = p.id
        WHERE ra."resourceId" = @id
        ORDER BY ra."assignmentType", p."displayName"
      `);
    res.json(r.recordset);
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
    const r = await timedRequest(pool, 'resource-business-roles', res)
      .input('id', req.params.id)
      .query(`
        SELECT DISTINCT rr."parentResourceId" AS "businessRoleId", br."displayName" AS "businessRoleName",
               rr."roleName", rr."relationshipType"
        FROM "ResourceRelationships" rr
        INNER JOIN "Resources" br ON rr."parentResourceId" = br.id
          AND br."resourceType" = 'BusinessRole'
        WHERE rr."childResourceId" = @id AND rr."relationshipType" = 'Contains'
          AND rr."parentResourceId" IS NOT NULL
        ORDER BY br."displayName"
      `);
    res.json(r.recordset);
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
    const r = await timedRequest(pool, 'resource-parents', res)
      .input('id', req.params.id)
      .query(`
        SELECT rr."parentResourceId", pr."displayName" AS "parentDisplayName",
               pr."resourceType" AS "parentResourceType", rr."relationshipType", rr."roleName"
        FROM "ResourceRelationships" rr
        LEFT JOIN "Resources" pr ON pr.id = rr."parentResourceId"
        WHERE rr."childResourceId" = @id
        ORDER BY rr."relationshipType", COALESCE(pr."displayName", rr."parentResourceId"::text)
      `);
    res.json(r.recordset);
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
    const r = await timedRequest(pool, 'resource-members', res)
      .input('id', req.params.id)
      .query(`
        SELECT p."resourceId", p."principalId" AS "memberId",
               u."displayName" AS "memberDisplayName", u."email" AS "memberUPN",
               p."membershipType", p."managedByAccessPackage"
          FROM ${table} p
          LEFT JOIN "Principals" u ON p."principalId" = u.id
         WHERE p."resourceId"::text = @id
         ORDER BY u."displayName", p."membershipType"
      `);
    res.json(r.recordset);
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
      const tagResult = await p.request().query(`
        SELECT t.name
        FROM "GraphTags" t
        WHERE t."entityType" IN ('resource', 'group')
          AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
        ORDER BY t.name
      `);
      const resourceTags = tagResult.recordset.map(r => r.name);
      grouped['__resourceTag'] = schemaOnly ? [] : resourceTags;
    } catch { /* tag tables may not exist yet */ }

    // Add virtual systemName column (source crawler / system display names)
    try {
      const sysResult = await p.request().query(`
        SELECT DISTINCT s."displayName" AS name
        FROM "Systems" s
        WHERE EXISTS (SELECT 1 FROM "Resources" r WHERE r."systemId" = s.id)
        ORDER BY s."displayName"
      `);
      grouped['__systemName'] = schemaOnly ? [] : sysResult.recordset.map(r => r.name);
    } catch { /* Systems table may not exist yet */ }

    return res.json(Object.entries(grouped).map(([column, values]) => ({ column, values })));
  } catch (err) {
    console.error('resource-columns query failed:', err.message);
    return res.json([]);
  }
});

export default router;
