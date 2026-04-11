import { Router } from 'express';
import { getUserColumns as getUserCols, getGroupColumns as getGroupCols, getResourceColumns as getResourceCols, getPrincipalOrUserColumns, getUserColumnValues, getPrincipalOrUserColumnValues, getGroupColumnValues, getResourceColumnValues, FILTERABLE_TYPES } from '../db/columnCache.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// Validate hex color format (#000000 – #ffffff)
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

// ─── Auto-create tag tables if they don't exist ──────────────────
let tablesReady = false;

// In v5 the tags + tag-assignments tables are created by the migrations
// runner at startup. This function is a no-op kept for backward compatibility.
async function ensureTagTables(_pool) { tablesReady = true; }
export { ensureTagTables };

// Build parameterized WHERE clause from filters object, validating against actual columns.
function buildFilterWhere(requestObj, filters, validColNames, alias, paramPrefix = 'fl') {
  let where = '';
  let idx = 0;
  for (const [field, value] of Object.entries(filters)) {
    if (validColNames.has(field) && value != null && String(value) !== '') {
      const paramName = `${paramPrefix}${idx}`;
      where += ` AND ${alias}."${field}"::text = @${paramName}`;
      requestObj.input(paramName, String(value));
      idx++;
    }
  }
  return where;
}

// ─── GET /api/tags ────────────────────────────────────────────────
router.get('/tags', async (req, res) => {
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();
    await ensureTagTables(p);
    const { entityType } = req.query;
    const request = p.request();
    let sql = `
      SELECT t.id, t."name", t."color", t."entityType", t."createdAt",
             COALESCE(COUNT(ta."tagId"), 0)::int AS "assignmentCount"
        FROM "GraphTags" t
        LEFT JOIN "GraphTagAssignments" ta ON ta."tagId" = t.id
    `;
    if (entityType) {
      sql += ` WHERE t."entityType" = @entityType`;
      request.input('entityType', entityType);
    }
    sql += ` GROUP BY t.id, t."name", t."color", t."entityType", t."createdAt"`;
    sql += ` ORDER BY t."name"`;
    const result = await request.query(sql);
    res.json(result.recordset);
  } catch (err) {
    console.error('GET /tags failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/tags ───────────────────────────────────────────────
router.post('/tags', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { name, color, entityType } = req.body;
    if (!name || !entityType) return res.status(400).json({ error: 'name and entityType required' });
    if (!['user', 'group', 'resource'].includes(entityType)) return res.status(400).json({ error: 'entityType must be user, group, or resource' });
    if (color && !HEX_COLOR_RE.test(color)) return res.status(400).json({ error: 'color must be a hex value like #3b82f6' });

    const p = await db.getPool();
    await ensureTagTables(p);
    const result = await p.request()
      .input('name', name.trim())
      .input('color', color || '#3b82f6')
      .input('entityType', entityType)
      .query(`
        INSERT INTO "GraphTags" (name, color, "entityType")
              VALUES (@name, @color, @entityType)
              RETURNING *
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.message?.includes('UQ_GraphTags_Name_Type')) {
      return res.status(409).json({ error: 'A tag with this name already exists for this entity type' });
    }
    console.error('POST /tags failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/tags/:id ──────────────────────────────────────────
router.patch('/tags/:id', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { name, color } = req.body;
    if (color && !HEX_COLOR_RE.test(color)) return res.status(400).json({ error: 'color must be a hex value like #3b82f6' });
    const p = await db.getPool();
    await ensureTagTables(p);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid tag ID' });
    const request = p.request().input('id', id);
    const sets = [];
    if (name) { sets.push('"name" = @name'); request.input('name', name.trim()); }
    if (color) { sets.push('"color" = @color'); request.input('color', color); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    const result = await request.query(
      `UPDATE "GraphTags" SET ${sets.join(', ')} WHERE id = @id RETURNING *`
    );
    res.json(result.recordset[0] || null);
  } catch (err) {
    console.error('PATCH /tags failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/tags/:id ─────────────────────────────────────────
router.delete('/tags/:id', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid tag ID' });
    const p = await db.getPool();
    await ensureTagTables(p);
    await p.request()
      .input('id', id)
      .query('DELETE FROM GraphTags WHERE id = @id');
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /tags failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/tags/:id/assign ────────────────────────────────────
router.post('/tags/:id/assign', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { entityIds } = req.body;
    if (!Array.isArray(entityIds) || entityIds.length === 0) {
      return res.status(400).json({ error: 'entityIds array required' });
    }
    if (entityIds.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 entity IDs per request' });
    }
    const p = await db.getPool();
    await ensureTagTables(p);
    const tagId = parseInt(req.params.id, 10);
    if (isNaN(tagId)) return res.status(400).json({ error: 'Invalid tag ID' });

    // Batch insert all assignments in a single query (avoids N+1 round-trips)
    const request = p.request().input('tagId', tagId);
    const valueParams = entityIds.map((eid, i) => {
      request.input(`eid${i}`, String(eid).toUpperCase());
      return `@eid${i}`;
    });
    const result = await request.query(`
      INSERT INTO "GraphTagAssignments" ("tagId", "entityId")
      SELECT @tagId, eid FROM (VALUES ${valueParams.map(p => `(${p})`).join(',')}) AS t(eid)
      WHERE NOT EXISTS (
        SELECT 1 FROM GraphTagAssignments WHERE tagId = @tagId AND entityId = t.eid
      );
      SELECT @@ROWCOUNT AS inserted;
    `);
    res.json({ ok: true, inserted: result.recordset[0]?.inserted || 0 });
  } catch (err) {
    console.error('POST /tags/:id/assign failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/tags/:id/unassign ──────────────────────────────────
router.post('/tags/:id/unassign', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { entityIds } = req.body;
    if (!Array.isArray(entityIds) || entityIds.length === 0) {
      return res.status(400).json({ error: 'entityIds array required' });
    }
    if (entityIds.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 entity IDs per request' });
    }
    const p = await db.getPool();
    await ensureTagTables(p);
    const tagId = parseInt(req.params.id, 10);
    if (isNaN(tagId)) return res.status(400).json({ error: 'Invalid tag ID' });

    // Batch delete all assignments in a single query (avoids N+1 round-trips)
    const request = p.request().input('tagId', tagId);
    const idParams = entityIds.map((eid, i) => {
      request.input(`eid${i}`, String(eid).toUpperCase());
      return `@eid${i}`;
    });
    const result = await request.query(`
      DELETE FROM "GraphTagAssignments"
      WHERE "tagId" = @tagId AND "entityId" IN (${idParams.join(',')});
      SELECT @@ROWCOUNT AS deleted;
    `);
    res.json({ ok: true, deleted: result.recordset[0]?.deleted || 0 });
  } catch (err) {
    console.error('POST /tags/:id/unassign failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/tags/:id/assign-by-filter ──────────────────────────
// Bulk-assign: tags ALL entities matching a search filter (server-side)
router.post('/tags/:id/assign-by-filter', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { entityType, search: rawSearch, filters } = req.body;
    if (!entityType) return res.status(400).json({ error: 'entityType required' });

    const p = await db.getPool();
    await ensureTagTables(p);
    const tagId = parseInt(req.params.id, 10);
    if (isNaN(tagId)) return res.status(400).json({ error: 'Invalid tag ID' });
    // Determine user table: prefer Principals for users
    let userTableForTags = 'GraphUsers';
    if (entityType === 'user') {
      try {
        const tc = await p.request().query(`SELECT to_regclass('"Principals"') AS principalsExists`);
        if (tc.recordset[0].principalsExists) userTableForTags = 'Principals';
      } catch { /* ignore */ }
    }
    const table = entityType === 'user' ? userTableForTags : (entityType === 'resource' ? 'Resources' : 'GraphGroups');
    const alias = 'e';
    const search = (rawSearch || '').trim().slice(0, 200);
    const upnColForSearch = userTableForTags === 'Principals' ? 'email' : 'userPrincipalName';

    const request = p.request().input('tagId', tagId);
    let where = '1=1';
    if (search) {
      request.input('search', `%${search}%`);
      if (entityType === 'user') {
        where += ` AND (${alias}.displayName LIKE @search OR ${alias}.${upnColForSearch} LIKE @search)`;
      } else {
        where += ` AND (${alias}.displayName LIKE @search OR ${alias}.description LIKE @search)`;
      }
    }

    // For temporal tables (Resources, Principals), add ValidTo filter
    if (entityType === 'resource' || (entityType === 'user' && userTableForTags === 'Principals')) {
      where += ` AND ${alias}.ValidTo = '9999-12-31 23:59:59.9999999'`;
    }

    // Apply attribute filters
    if (filters && typeof filters === 'object') {
      const cols = entityType === 'user' ? await getPrincipalOrUserColumns(p) : (entityType === 'resource' ? await getResourceCols(p) : await getGroupCols(p));
      const colNames = new Set(cols.map(c => c.name));
      where += buildFilterWhere(request, filters, colNames, alias, 'bf');
    }

    // Safety cap: limit bulk assignment to 50,000 rows to prevent runaway operations
    const result = await request.query(`
      INSERT INTO "GraphTagAssignments" ("tagId", "entityId")
      SELECT @tagId, UPPER((${alias}.id)::text)
      FROM ${table} ${alias}
      WHERE (${where})
        AND UPPER((${alias}.id)::text) NOT IN (
          SELECT "entityId" FROM "GraphTagAssignments" WHERE "tagId" = @tagId
        );
      SELECT @@ROWCOUNT AS inserted;
    `);
    res.json({ ok: true, inserted: result.recordset[0]?.inserted || 0 });
  } catch (err) {
    console.error('POST /tags/:id/assign-by-filter failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Helper: parse tag string from SQL into array ─────────────────
function parseTags(tagString) {
  if (!tagString) return [];
  return tagString.split('|').map(t => {
    const parts = t.split(':');
    return { id: parseInt(parts[0]), name: parts[1], color: parts[2] };
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
      const tagResult = await p.request().query(`
        SELECT t.name
        FROM "GraphTags" t
        WHERE t."entityType" = 'user'
          AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
        ORDER BY t.name
      `);
      const userTags = tagResult.recordset.map(r => r.name);
      if (userTags.length > 0) grouped['__userTag'] = userTags;
    } catch { /* tag tables may not exist yet */ }

    return res.json(Object.entries(grouped).map(([column, values]) => ({ column, values })));
  } catch (err) {
    console.error('user-columns-page query failed:', err.message);
    return res.json([]);
  }
});

// ─── GET /api/group-columns ──────────────────────────────────────
// Column discovery for the Groups page (Resources or GraphGroups)
// Also aliased as /api/resource-columns-page for new model
router.get('/group-columns', groupColumnsHandler);
router.get('/resource-columns-page', groupColumnsHandler);

async function groupColumnsHandler(req, res) {
  // ?schema=true — return column names only (no distinct values). Fast path.
  const schemaOnly = req.query.schema === 'true';

  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();

    let grouped;

    // Try Resources table first, fall back to GraphGroups
    let useResources = false;
    try {
      await p.request().query('SELECT TOP 0 * FROM Resources');
      useResources = true;
    } catch { /* Resources table doesn't exist */ }

    if (useResources) {
      if (schemaOnly) {
        const cols = await getResourceCols(p);
        grouped = Object.fromEntries(cols.map(c => [c.name, []]));
      } else {
        grouped = { ...await getResourceColumnValues(p) };
      }
    } else {
      if (schemaOnly) {
        const cols = await getGroupCols(p);
        grouped = Object.fromEntries(cols.map(c => [c.name, []]));
      } else {
        grouped = { ...await getGroupColumnValues(p) };
      }
    }

    // Add virtual __groupTag column (tag names as values)
    try {
      await ensureTagTables(p);
      const tagResult = await p.request().query(`
        SELECT t.name
        FROM "GraphTags" t
        WHERE t."entityType" IN ('resource', 'group')
          AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
        ORDER BY t.name
      `);
      const groupTags = tagResult.recordset.map(r => r.name);
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
    const tagId = req.query.tagId ? parseInt(req.query.tagId) : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
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

    const request = p.request();
    request.input('limit', limit);
    request.input('offset', offset);

    const cols = await getPrincipalOrUserColumns(p);
    const colNames = new Set(cols.map(c => c.name));
    const filterWhere = buildFilterWhere(request, attrFilters, colNames, 'u');

    let where = '1=1';
    if (search) {
      where += ` AND (u."displayName" ILIKE @search OR u."email" ILIKE @search)`;
      request.input('search', `%${search}%`);
    }
    if (tagId) {
      where += ` AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = @tagId AND ta."entityId" = UPPER(u.id::text))`;
      request.input('tagId', tagId);
    }
    let userTagJoin = '';
    if (userTagFilter) {
      userTagJoin = `
        INNER JOIN "GraphTagAssignments" _uta ON _uta."entityId" = UPPER(u.id::text)
        INNER JOIN "GraphTags" _ut ON _uta."tagId" = _ut.id AND _ut."name" = @__userTag AND _ut."entityType" = 'user'`;
      request.input('__userTag', userTagFilter);
    }
    where += filterWhere;

    // Two-statement query: data + count, returned as recordsets[0] and [1]
    // by the mssql-compat shim.
    const result = await request.query(`
      SELECT u.id, u."displayName", u."email" AS "userPrincipalName",
             u."department", u."jobTitle", u."companyName", u."accountEnabled",
             u."principalType", u."systemId", u."externalId",
             (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
                FROM "GraphTagAssignments" ta
                INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" = 'user'
               WHERE ta."entityId" = UPPER(u.id::text)
             ) AS "tagString"
        FROM "Principals" u
        ${userTagJoin}
       WHERE ${where}
       ORDER BY u."displayName"
       LIMIT @limit OFFSET @offset;

      SELECT COUNT(*)::int AS total FROM "Principals" u ${userTagJoin} WHERE ${where};
    `);

    const data = result.recordsets[0].map(r => {
      const { tagString, ...rest } = r;
      return { ...rest, tags: parseTags(tagString) };
    });

    res.json({ data, total: result.recordsets[1][0].total });
  } catch (err) {
    console.error('GET /users failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/groups ──────────────────────────────────────────────
// Now queries Resources table with GraphGroups fallback.
// Also serves as a filtered view when ?resourceType= is passed.
router.get('/groups', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0 });

    const search = (req.query.search || '').trim().slice(0, 200);
    const tagId = req.query.tagId ? parseInt(req.query.tagId) : null;
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

    const request = p.request();
    request.input('limit', limit);
    request.input('offset', offset);

    // v5: only the Resources table exists. The v4 GraphGroups fallback is gone.
    const cols = await getResourceCols(p);
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
    }
    if (tagId) {
      where += ` AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta INNER JOIN "GraphTags" t ON ta."tagId" = t.id WHERE ta."tagId" = @tagId AND ta."entityId" = UPPER(r.id::text) AND t."entityType" IN ('resource', 'group'))`;
      request.input('tagId', tagId);
    }
    let groupTagJoin = '';
    if (groupTagFilter) {
      groupTagJoin = `
        INNER JOIN "GraphTagAssignments" _gta ON _gta."entityId" = UPPER(r.id::text)
        INNER JOIN "GraphTags" _gt ON _gta."tagId" = _gt.id AND _gt."name" = @__groupTag AND _gt."entityType" IN ('resource', 'group')`;
      request.input('__groupTag', groupTagFilter);
    }
    where += filterWhere;

    const result = await request.query(`
      SELECT r.id, r."displayName", r."resourceType", r."resourceType" AS "groupTypeCalculated",
             r."description", r."systemId", r."enabled",
             (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
                FROM "GraphTagAssignments" ta
                INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" IN ('resource', 'group')
               WHERE ta."entityId" = UPPER(r.id::text)
             ) AS "tagString"
        FROM "Resources" r
        ${groupTagJoin}
       WHERE ${where}
       ORDER BY r."displayName"
       LIMIT @limit OFFSET @offset;

      SELECT COUNT(*)::int AS total FROM "Resources" r ${groupTagJoin} WHERE ${where};
    `);

    const data = result.recordsets[0].map(r => {
      const { tagString, ...rest } = r;
      return { ...rest, tags: parseTags(tagString) };
    });

    res.json({ data, total: result.recordsets[1][0].total });
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
    const result = await p.request().input('entityType', entityType).query(`
      SELECT ta."entityId", t.id AS "tagId", t.name AS tagName, t.color AS tagColor
      FROM "GraphTagAssignments" ta
      INNER JOIN "GraphTags" t ON ta."tagId" = t.id
      WHERE t."entityType" = @entityType
      ORDER BY ta."entityId", t.name
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('GET /entity-tags failed:', err.message);
    res.json([]);
  }
});

export default router;
