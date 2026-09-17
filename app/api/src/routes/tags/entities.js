// Entity list + column-discovery endpoints — /api/users, /api/groups,
// /api/entity-tags and the *-columns-page discovery routes the Users/Groups
// pages use for their filter bars.
//
// Extracted verbatim from routes/tags.js (audit finding C1). Mounted by
// routes/tags.js via router.use(), so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import { getResourceColumns as getResourceCols, getPrincipalOrUserColumns, getPrincipalOrUserColumnValues, getResourceColumnValues } from '../../db/columnCache.js';
import { createParams, likeContains } from '../../db/sqlParams.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { buildOrderBy } from '../../lib/listSort.js';
import { parseListParams } from '../../lib/listParams.js';
import { useSql, db, ensureTagTables, buildFilterWhere, UUID_RE, parseTags } from './shared.js';
import { extractRelFilters, buildRelationshipWhere, discoverReferenceFields } from '../../lib/referenceFilters.js';
import { withAttributeLabels } from '../../lib/attributeLabels.js';
import { addSystemColumn, extractSystemFilter, systemFilterWhere } from '../../lib/systemFilter.js';
import { aggregateActivityLateral } from '../../lib/principalActivity.js';
import {
  addLastSignInColumn, extractLastSignInFilter, lastSignInFilterWhere,
} from '../../lib/lastSignInFilter.js';

const router = Router();

// Columns the Users page lets you sort by (its TABLE_COLUMNS keys). Values are
// the page CTE's output aliases — safe to interpolate; see lib/listSort.js.
//
// `lastSignIn` sorts nulls last in BOTH directions on purpose: "never signed
// in" is the absence of a value, not the oldest one, so it belongs at the end
// of the list whichever way round the dates run.
const USER_SORTS = {
  displayName: '"displayName"',
  userPrincipalName: '"userPrincipalName"',
  department: '"department"',
  jobTitle: '"jobTitle"',
  lastSignIn: '"lastSignIn" {dir} NULLS LAST',
};

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

    // Virtual __system column — system display names, sourced from the Systems
    // table so a system with no principals is still offered.
    await addSystemColumn(grouped);
    // Virtual __lastSignIn column — fixed age buckets, not stored values.
    addLastSignInColumn(grouped);

    const columns = Object.entries(grouped).map(([column, values]) => ({ column, values }));

    // Reference-field (relationship) filters, scoped to the active principalType
    // sub-tab so only relationships with data in THIS view are offered.
    try {
      const relFields = await discoverReferenceFields('principals', { principalType: req.query.principalType });
      columns.push(...relFields);
    } catch (e) { console.error('user reference-field discovery failed:', e.message); }

    return res.json(await withAttributeLabels(columns, 'principal'));
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

    // Virtual __system column — system display names, sourced from the Systems
    // table so a system with no resources is still offered.
    await addSystemColumn(grouped, { schemaOnly });

    return res.json(await withAttributeLabels(
      Object.entries(grouped).map(([column, values]) => ({ column, values })), 'resource'));
  } catch (err) {
    console.error('group-columns query failed:', err.message);
    return res.json([]);
  }
}

// ─── GET /api/users ───────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const { search, limit, offset, attrFilters } = parseListParams(req);
    const tagId = req.query.tagId && UUID_RE.test(String(req.query.tagId)) ? String(req.query.tagId) : null;

    let userTagFilter = null;
    if (attrFilters['__userTag']) {
      userTagFilter = String(attrFilters['__userTag']);
      delete attrFilters['__userTag'];
    }
    // Virtual __system filter — translated into a systemId predicate below.
    const systemFilter = extractSystemFilter(attrFilters);
    // Virtual __lastSignIn filter — an age bucket over the activity lateral.
    const lastSignInFilter = extractLastSignInFilter(attrFilters);
    // Pull reference-field (rel.*) filters out before column validation — they
    // are applied as correlated count subqueries, not scalar column matches.
    const relFilters = extractRelFilters(attrFilters);

    const p = await db.getPool();
    await ensureTagTables(p);

    const { params, bind } = createParams();

    const cols = await getPrincipalOrUserColumns(p);
    const colNames = new Set(cols.map(c => c.name));

    let where = '1=1';
    // Hide soft-deleted principals by default; ?includeDeleted=true reveals them.
    if (req.query.includeDeleted !== 'true') where += ` AND u."deletedAt" IS NULL`;
    if (search) {
      const s = bind(likeContains(search));
      where += ` AND (u."displayName" ILIKE ${s} ESCAPE '\\' OR u."email" ILIKE ${s} ESCAPE '\\')`;
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
    where += systemFilterWhere(systemFilter, 'u', bind);
    where += lastSignInFilterWhere(lastSignInFilter, 'act', bind);
    where += buildRelationshipWhere(relFilters, 'principals', 'u');

    // Sign-in activity rides along as a lateral rather than as columns on
    // Principals: PrincipalActivity is deliberately the only home for it (it
    // sits outside the _history triggers), and the same join feeds the UI table,
    // the sort, the bucket filter and the Excel export from this one endpoint.
    const activityJoin = aggregateActivityLateral('u', 'act');

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
    // Sort the whole result set server-side (audit H-14) so "top N" is correct
    // past page 1; the same expression orders the page window and the outer
    // tag-resolving select, both over the page CTE's output aliases.
    const orderBy = buildOrderBy(req.query.sort, req.query.dir, USER_SORTS);
    const baseSql = `
      WITH page AS (
        SELECT u.id, u."displayName", u."email" AS "userPrincipalName",
               u."department", u."jobTitle", u."companyName", u."accountEnabled",
               u."principalType", u."systemId", u."externalId",
               u."givenName", u."surname", u."employeeId", u."managerId",
               u."createdDateTime", u."extendedAttributes",
               u."riskScore", u."riskTier", u."deletedAt",
               act."lastSignIn", act."measuredAt" AS "lastSignInMeasuredAt"
          FROM "Principals" u
          ${userTagJoin}
          ${activityJoin}
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT ${bind(limit)} OFFSET ${bind(offset)}
      )
      SELECT page.*,
             (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
                FROM "GraphTagAssignments" ta
                INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" = 'user'
               WHERE ta."entityId" = UPPER(page.id::text)
             ) AS "tagString"
        FROM page
       ORDER BY ${orderBy}`;
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
      const countSql = `SELECT COUNT(*)::int AS total FROM "Principals" u ${userTagJoin} ${activityJoin} WHERE ${where}`;
      total = (await db.query(countSql, countParams)).rows[0]?.total ?? null;
    }
    res.json({ data, total });
  } catch (err) {
    console.error('GET /users failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Parse the /groups list query params + tag filter (pulled out of attrFilters).
function parseGroupsListParams(req) {
  const search = (req.query.search || '').trim().slice(0, 200);
  const tagId = req.query.tagId && UUID_RE.test(String(req.query.tagId)) ? String(req.query.tagId) : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const resourceType = (req.query.resourceType || '').trim();

  let attrFilters = {};
  if (req.query.filters) {
    try { attrFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
  }
  let groupTagFilter = null;
  if (attrFilters['__groupTag']) {
    groupTagFilter = String(attrFilters['__groupTag']);
    delete attrFilters['__groupTag'];
  } else if (attrFilters['__resourceTag']) {
    groupTagFilter = String(attrFilters['__resourceTag']);
    delete attrFilters['__resourceTag'];
  }
  const systemFilter = extractSystemFilter(attrFilters);
  return { search, tagId, limit, offset, resourceType, attrFilters, groupTagFilter, systemFilter };
}

// Build the /groups WHERE + optional tag-filter JOIN, binding via `bind`.
function buildGroupsListWhere(parsed, colNames, bind) {
  const { search, tagId, resourceType, attrFilters, groupTagFilter, systemFilter } = parsed;
  let where = '1=1';
  if (search) {
    const s = bind(likeContains(search));
    where += ` AND (r."displayName" ILIKE ${s} ESCAPE '\\' OR r."description" ILIKE ${s} ESCAPE '\\')`;
  }
  if (resourceType) where += ` AND r."resourceType" = ${bind(resourceType)}`;
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
  where += systemFilterWhere(systemFilter, 'r', bind);
  return { where, groupTagJoin };
}

// ─── GET /api/groups ──────────────────────────────────────────────
// Queries the Resources table (v5 has no GraphGroups fallback).
// Also serves as a filtered view when ?resourceType= is passed.
router.get('/groups', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const parsed = parseGroupsListParams(req);
    const { limit, offset } = parsed;

    const p = await db.getPool();
    await ensureTagTables(p);

    const { params, bind } = createParams();

    // v5: only the Resources table exists. The v4 GraphGroups fallback is gone.
    const cols = await getResourceCols(p);
    const colNames = new Set(cols.map(c => c.name));

    const { where, groupTagJoin } = buildGroupsListWhere(parsed, colNames, bind);

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
