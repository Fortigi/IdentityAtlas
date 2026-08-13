import { Router } from 'express';
import { timedQuery } from '../perf/sqlTimer.js';
import { createParams } from '../db/sqlParams.js';
import { buildOrderBy } from '../lib/listSort.js';
import { getResourceColumns, getResourceColumnValues } from '../db/columnCache.js';
import { ensureTagTables } from './tags.js';
import { discoverReferenceFields } from '../lib/referenceFilters.js';
import { UUID_RE, cleanRow, getPermissionTable } from './details/shared.js';
import { isMissingSchema } from '../db/schemaErrors.js';
import { buildResourceContextsSql } from '../matrix/resourceContexts.js';
import { parseResourceListParams, buildResourceListWhere, mapResourceRow } from './resources/list.js';
import {
  fetchResourceAttributes, mergeResourceRiskScore, fetchResourceTags, fetchMemberBreakdown,
  fetchAccessPackageCount, fetchParentResourceCount, fetchResourceHistoryCount, fetchResourceContextCount,
} from './resources/detail.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// Columns the Groups/Resources page lets you sort by (its TABLE_COLUMNS keys).
// Values are the page CTE's output aliases — safe to interpolate; see
// lib/listSort.js.
const RESOURCE_SORTS = {
  displayName: '"displayName"',
  resourceType: '"resourceType"',
  description: '"description"',
};

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

// ─── GET /api/resources ─────────────────────────────────────────
// List resources with pagination, filtering, and search
router.get('/resources', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const parsed = parseResourceListParams(req);

    const p = await db.getPool();
    await ensureTagTables(p);

    const { params, bind } = createParams();

    // Validate attribute filters against actual columns
    const cols = await getResourceColumns(p);
    const colNames = new Set(cols.map(c => c.name));

    const { where, resourceTagJoin } = buildResourceListWhere(req, parsed, colNames, bind);

    // Returns every Resources column so the same endpoint feeds the UI grid AND
    // the Power Query Excel export (which auto-expands extendedAttributes into
    // first-class ext_* columns). Page first, then resolve tags only for the
    // page rows; count only on page 1. Snapshot the filter params before binding
    // the page window so the COUNT query isn't handed the LIMIT/OFFSET values it
    // never references.
    const countParams = [...params];
    // Sort the whole result set server-side (audit H-14) so "top N" is correct
    // past page 1; the same expression orders the page window and the outer
    // tag-resolving select, both over the page CTE's output aliases.
    const orderBy = buildOrderBy(req.query.sort, req.query.dir, RESOURCE_SORTS);
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
         ORDER BY ${orderBy}
         LIMIT ${bind(parsed.limit)} OFFSET ${bind(parsed.offset)}
      )
      SELECT page.*,
             (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
                FROM "GraphTagAssignments" ta
                INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" IN ('resource', 'group')
               WHERE ta."entityId" = UPPER(page.id::text)
             ) AS "tagString"
        FROM page
       ORDER BY ${orderBy}`;
    const dataResult = await db.query(baseSql, params);

    const data = dataResult.rows.map(mapResourceRow);

    let total = null;
    if (parsed.offset === 0) {
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

    // Attributes first — a missing row is a 404 before we fetch the rest.
    const attributes = await fetchResourceAttributes(pool, res, resourceId);
    if (attributes === null) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    await mergeResourceRiskScore(attributes, resourceId);

    // The remaining sections are independent optional fetches; each swallows a
    // missing optional table and rethrows anything else to the 500 below.
    const tags = await fetchResourceTags(pool, res, resourceId);
    const { memberCount, assignmentByType } = await fetchMemberBreakdown(pool, res, resourceId);
    const accessPackageCount = await fetchAccessPackageCount(pool, res, resourceId);
    const parentResourceCount = await fetchParentResourceCount(pool, res, resourceId);
    const historyCount = await fetchResourceHistoryCount(resourceId);
    const contextCount = await fetchResourceContextCount(resourceId);

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
      buildResourceContextsSql('cm."memberId"::text = $1'),
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

    const columns = Object.entries(grouped).map(([column, values]) => ({ column, values }));

    // Reference-field (relationship) filters for resources — only offered where
    // data exists. Skipped on the schema-only fast path (no values needed).
    if (!schemaOnly) {
      try {
        const relFields = await discoverReferenceFields('resources', { resourceType: req.query.resourceType });
        columns.push(...relFields);
      } catch (e) { console.error('resource reference-field discovery failed:', e.message); }
    }

    return res.json(columns);
  } catch (err) {
    console.error('resource-columns query failed:', err.message);
    return res.json([]);
  }
});

export default router;
