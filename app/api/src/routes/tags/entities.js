// Entity list + column-discovery endpoints — /api/users, /api/groups,
// /api/entity-tags and the *-columns-page discovery routes the Users/Groups
// pages use for their filter bars.
//
// Extracted verbatim from routes/tags.js (audit finding C1). Mounted by
// routes/tags.js via router.use(), so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import { getResourceColumns as getResourceCols, getPrincipalOrUserColumns, getPrincipalOrUserColumnValues, getResourceColumnValues } from '../../db/columnCache.js';
import { createParams } from '../../db/sqlParams.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { useSql, db, ensureTagTables, buildFilterWhere, UUID_RE } from './shared.js';

const router = Router();

// ─── Helper: parse tag string from SQL into array ─────────────────
// Tag IDs are UUID strings (v6) — do not parseInt.
function parseTags(tagString) {
  if (!tagString) return [];
  return tagString.split('|').map(t => {
    const parts = t.split(':');
    return { id: parts[0], name: parts[1], color: parts[2] };
  });
}

// ─── GET /api/user-columns-page ──────────────────────────────────
// Column discovery for the Users page (distinct values from GraphUsers)
router.get('/user-columns-page', async (req, res) => {
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();

    // Use cached distinct values (5-min TTL — avoids 44s UNION ALL on every load)
    const grouped = { ...await getPrincipalOrUserColumnValues(p) };

    // Add virtual __userTag column (tag names as values)
    try {
      await ensureTagTables(p);
      const tagResult = await db.query(`
        SELECT t.name
        FROM "GraphTags" t
        WHERE t."entityType" = 'user'
          AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
        ORDER BY t.name
      `);
      const userTags = tagResult.rows.map(r => r.name);
      if (userTags.length > 0) grouped['__userTag'] = userTags;
    } catch { /* tag tables may not exist yet */ }

    return res.json(Object.entries(grouped).map(([column, values]) => ({ column, values })));
  } catch (err) {
    console.error('user-columns-page query failed:', err.message);
    return res.json([]);
  }
});

// ─── GET /api/group-columns ──────────────────────────────────────
// Column discovery for the Resources page (distinct values from Resources).
// Also aliased as /api/resource-columns-page.
router.get('/group-columns', groupColumnsHandler);
router.get('/resource-columns-page', groupColumnsHandler);

async function groupColumnsHandler(req, res) {
  // ?schema=true — return column names only (no distinct values). Fast path.
  const schemaOnly = req.query.schema === 'true';

  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();

    // v5: only the Resources table exists. The v4 GraphGroups fallback is gone
    // (removed with the rest of GraphGroups in #667/#678). The former existence
    // probe used `SELECT TOP 0 * FROM Resources` — T-SQL that always threw on
    // Postgres, so this endpoint silently served legacy group columns instead.
    let grouped;
    if (schemaOnly) {
      const cols = await getResourceCols(p);
      grouped = Object.fromEntries(cols.map(c => [c.name, []]));
    } else {
      grouped = { ...await getResourceColumnValues(p) };
    }

    // Add virtual __groupTag column (tag names as values)
    try {
      await ensureTagTables(p);
      const tagResult = await db.query(`
        SELECT t.name
        FROM "GraphTags" t
        WHERE t."entityType" IN ('resource', 'group')
          AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
        ORDER BY t.name
      `);
      const groupTags = tagResult.rows.map(r => r.name);
      grouped['__groupTag'] = schemaOnly ? [] : groupTags;
    } catch { /* tag tables may not exist yet */ }

    return res.json(Object.entries(grouped).map(([column, values]) => ({ column, values })));
  } catch (err) {
    console.error('group-columns query failed:', err.message);
    return res.json([]);
  }
}

// ─── GET /api/users ───────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const search = (req.query.search || '').trim().slice(0, 200);
    const tagId = req.query.tagId && UUID_RE.test(String(req.query.tagId)) ? String(req.query.tagId) : null;
    // Cap at 10k to match the bulk-list endpoints. The UI defaults to 100
    // and never asks for more; the higher cap is there so Power Query /
    // BI exports can page through the full dataset in fewer round trips.
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 10000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    let attrFilters = {};
    if (req.query.filters) {
      try { attrFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
    }
    let userTagFilter = null;
    if (attrFilters['__userTag']) {
      userTagFilter = String(attrFilters['__userTag']);
      delete attrFilters['__userTag'];
    }

    const p = await db.getPool();
    await ensureTagTables(p);

    const { params, bind } = createParams();

    const cols = await getPrincipalOrUserColumns(p);
    const colNames = new Set(cols.map(c => c.name));

    let where = '1=1';
    // Hide soft-deleted principals by default; ?includeDeleted=true reveals them.
    if (req.query.includeDeleted !== 'true') where += ` AND u."deletedAt" IS NULL`;
    if (search) {
      const s = bind(`%${search}%`);
      where += ` AND (u."displayName" ILIKE ${s} OR u."email" ILIKE ${s})`;
    }
    if (tagId) {
      where += ` AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = ${bind(tagId)} AND ta."entityId" = UPPER(u.id::text))`;
    }
    let userTagJoin = '';
    if (userTagFilter) {
      userTagJoin = `
        INNER JOIN "GraphTagAssignments" _uta ON _uta."entityId" = UPPER(u.id::text)
        INNER JOIN "GraphTags" _ut ON _uta."tagId" = _ut.id AND _ut."name" = ${bind(userTagFilter)} AND _ut."entityType" = 'user'`;
    }
    where += buildFilterWhere(attrFilters, colNames, 'u', bind);

    // Paginate FIRST (cheap), then resolve the per-row tag string only for the
    // page's rows. The tagString subquery used to sit in the top-level SELECT, so
    // Postgres evaluated it for every offset+limit row before OFFSET discarded the
    // first `offset` — O(offset) view-subqueries per page, quadratic across an
    // export, and slow enough on a large tenant to time out a deep page (the 500
    // the Power Query export hit). The CTE confines the subquery to the <=limit
    // page rows, making per-page cost ~constant regardless of depth.
    //
    // Returns the FULL Principals row so the same endpoint feeds both the UI table
    // and the Excel export (which auto-expands extendedAttributes).
    //
    // COUNT(*) runs only on the first page: the Excel workbook reads `total` once
    // from page 1 and then pages by row count, so re-counting the whole table on
    // every page was pure waste.
    const countParams = [...params]; // filter params only — snapshot before LIMIT/OFFSET
    const baseSql = `
      WITH page AS (
        SELECT u.id, u."displayName", u."email" AS "userPrincipalName",
               u."department", u."jobTitle", u."companyName", u."accountEnabled",
               u."principalType", u."systemId", u."externalId",
               u."givenName", u."surname", u."employeeId", u."managerId",
               u."createdDateTime", u."extendedAttributes",
               u."riskScore", u."riskTier", u."deletedAt"
          FROM "Principals" u
          ${userTagJoin}
         WHERE ${where}
         ORDER BY u."displayName"
         LIMIT ${bind(limit)} OFFSET ${bind(offset)}
      )
      SELECT page.*,
             (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
                FROM "GraphTagAssignments" ta
                INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" = 'user'
               WHERE ta."entityId" = UPPER(page.id::text)
             ) AS "tagString"
        FROM page
       ORDER BY page."displayName"`;
    const dataResult = await db.query(baseSql, params);

    const data = dataResult.rows.map(r => {
      const { tagString, extendedAttributes, ...rest } = r;
      // pg returns JSONB already parsed; parseJsonbColumn also handles a raw
      // string (older shim path). Either way the UI / Power Query gets a
      // record or null.
      const parsedExt = parseJsonbColumn(extendedAttributes);
      return { ...rest, extendedAttributes: parsedExt, tags: parseTags(tagString) };
    });

    let total = null;
    if (offset === 0) {
      const countSql = `SELECT COUNT(*)::int AS total FROM "Principals" u ${userTagJoin} WHERE ${where}`;
      total = (await db.query(countSql, countParams)).rows[0]?.total ?? null;
    }
    res.json({ data, total });
  } catch (err) {
    console.error('GET /users failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/groups ──────────────────────────────────────────────
// Queries the Resources table (v5 has no GraphGroups fallback).
// Also serves as a filtered view when ?resourceType= is passed.
router.get('/groups', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const search = (req.query.search || '').trim().slice(0, 200);
    const tagId = req.query.tagId && UUID_RE.test(String(req.query.tagId)) ? String(req.query.tagId) : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const resourceType = (req.query.resourceType || '').trim();

    // Parse attribute filters
    let attrFilters = {};
    if (req.query.filters) {
      try { attrFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
    }

    // Extract virtual tag filter before column validation
    let groupTagFilter = null;
    if (attrFilters['__groupTag']) {
      groupTagFilter = String(attrFilters['__groupTag']);
      delete attrFilters['__groupTag'];
    }
    // Also accept __resourceTag
    if (!groupTagFilter && attrFilters['__resourceTag']) {
      groupTagFilter = String(attrFilters['__resourceTag']);
      delete attrFilters['__resourceTag'];
    }

    const p = await db.getPool();
    await ensureTagTables(p);

    const { params, bind } = createParams();

    // v5: only the Resources table exists. The v4 GraphGroups fallback is gone.
    const cols = await getResourceCols(p);
    const colNames = new Set(cols.map(c => c.name));

    let where = '1=1';
    if (search) {
      const s = bind(`%${search}%`);
      where += ` AND (r."displayName" ILIKE ${s} OR r."description" ILIKE ${s})`;
    }
    if (resourceType) {
      where += ` AND r."resourceType" = ${bind(resourceType)}`;
    }
    if (tagId) {
      where += ` AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta INNER JOIN "GraphTags" t ON ta."tagId" = t.id WHERE ta."tagId" = ${bind(tagId)} AND ta."entityId" = UPPER(r.id::text) AND t."entityType" IN ('resource', 'group'))`;
    }
    let groupTagJoin = '';
    if (groupTagFilter) {
      groupTagJoin = `
        INNER JOIN "GraphTagAssignments" _gta ON _gta."entityId" = UPPER(r.id::text)
        INNER JOIN "GraphTags" _gt ON _gta."tagId" = _gt.id AND _gt."name" = ${bind(groupTagFilter)} AND _gt."entityType" IN ('resource', 'group')`;
    }
    where += buildFilterWhere(attrFilters, colNames, 'r', bind);

    // Page first, then resolve tags only for the page rows; count only on page 1.
    // Same fix as GET /users — stops deep export pages from re-running the per-row
    // tag subquery over every discarded offset row (quadratic → deep-page timeout).
    const countParams = [...params]; // filter params only — snapshot before LIMIT/OFFSET
    const baseSql = `
      WITH page AS (
        SELECT r.id, r."displayName", r."resourceType", r."resourceType" AS "groupTypeCalculated",
               r."description", r."systemId", r."enabled"
          FROM "Resources" r
          ${groupTagJoin}
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

    const data = dataResult.rows.map(r => {
      const { tagString, ...rest } = r;
      return { ...rest, tags: parseTags(tagString) };
    });

    let total = null;
    if (offset === 0) {
      const countSql = `SELECT COUNT(*)::int AS total FROM "Resources" r ${groupTagJoin} WHERE ${where}`;
      total = (await db.query(countSql, countParams)).rows[0]?.total ?? null;
    }
    res.json({ data, total });
  } catch (err) {
    console.error('GET /groups failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/entity-tags ────────────────────────────────────────
// Returns all tag assignments for a given entity type as a flat list.
// Query params: entityType ('user' | 'group')
// Response: [{ entityId, tagId, tagName, tagColor }]
router.get('/entity-tags', async (req, res) => {
  try {
    if (!useSql) return res.json([]);
    const { entityType } = req.query;
    if (!entityType || !['user', 'group', 'resource'].includes(entityType)) {
      return res.status(400).json({ error: 'entityType must be user, group, or resource' });
    }
    const p = await db.getPool();
    await ensureTagTables(p);
    const result = await db.query(`
      SELECT ta."entityId", t.id AS "tagId", t.name AS tagName, t.color AS tagColor
      FROM "GraphTagAssignments" ta
      INNER JOIN "GraphTags" t ON ta."tagId" = t.id
      WHERE t."entityType" = $1
      ORDER BY ta."entityId", t.name
    `, [entityType]);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /entity-tags failed:', err.message);
    res.json([]);
  }
});

export default router;
