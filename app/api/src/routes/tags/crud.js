// Tag CRUD + assignment endpoints — GET/POST/PATCH/DELETE /api/tags and
// /api/tags/:id/{assign,unassign,assign-by-filter}. Tags are stored as manual
// Contexts rows (contextType='Tag'); the GraphTags/GraphTagAssignments views
// give read compatibility while writes target Contexts + ContextMembers.
//
// Extracted verbatim from routes/tags.js (audit finding C1). Mounted by
// routes/tags.js via router.use(), so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getPrincipalOrUserColumns, getResourceColumns as getResourceCols, getGroupColumns as getGroupCols } from '../../db/columnCache.js';
import { getOrCreateTagRoot } from '../../bootstrap.js';
import { recalcMemberCountsForChain } from '../../contexts/memberCounts.js';
import { requirePermission } from '../../middleware/auth.js';
import { createParams } from '../../db/sqlParams.js';
import { useSql, db, ensureTagTables, buildFilterWhere, ENTITY_TO_TARGET, UUID_RE } from './shared.js';
import { extractRelFilters, buildRelationshipWhere, storeForEntityType } from '../../lib/referenceFilters.js';

const router = Router();
const writeTags = requirePermission('data.write.tags');

// Validate hex color format (#000000 – #ffffff)
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Reverse map for emitting back the entityType value the UI sends in.
const TARGET_TO_ENTITY = { Principal: 'user', Resource: 'resource', Identity: 'identity' };

function tagRowFromContext(c, assignmentCount) {
  return {
    id: c.id,
    name: c.displayName,
    color: (c.extendedAttributes && c.extendedAttributes.tagColor) || '#3b82f6',
    entityType: TARGET_TO_ENTITY[c.targetType] || 'resource',
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    assignmentCount: assignmentCount != null ? assignmentCount : undefined,
  };
}

router.get('/tags', async (req, res) => {
  try {
    if (!useSql) return res.json([]);
    const p = await db.getPool();
    await ensureTagTables(p);
    const { entityType } = req.query;
    const { params, bind } = createParams();
    let sql = `
      SELECT t.id, t."name", t."color", t."entityType", t."createdAt",
             COALESCE(COUNT(ta."tagId"), 0)::int AS "assignmentCount"
        FROM "GraphTags" t
        LEFT JOIN "GraphTagAssignments" ta ON ta."tagId" = t.id
    `;
    if (entityType) {
      sql += ` WHERE t."entityType" = ${bind(entityType)}`;
    }
    sql += ` GROUP BY t.id, t."name", t."color", t."entityType", t."createdAt"`;
    sql += ` ORDER BY t."name"`;
    const result = await db.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /tags failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// POST /api/tags
router.post('/tags', writeTags, async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { name, color, entityType } = req.body;
    if (!name || !entityType) return res.status(400).json({ error: 'name and entityType required' });
    if (!ENTITY_TO_TARGET[entityType]) {
      return res.status(400).json({ error: 'entityType must be one of user, group, resource, or identity' });
    }
    if (color && !HEX_COLOR_RE.test(color)) return res.status(400).json({ error: 'color must be a hex value like #3b82f6' });
    const targetType = ENTITY_TO_TARGET[entityType];

    // Enforce name-uniqueness per target type (the old UQ_GraphTags_Name_Type constraint).
    const dup = await db.queryOne(
      `SELECT id FROM "Contexts" WHERE "contextType" = 'Tag' AND "variant" = 'manual'
         AND "targetType" = $1 AND "displayName" = $2`,
      [targetType, name.trim()]
    );
    if (dup) return res.status(409).json({ error: 'A tag with this name already exists for this entity type' });

    const createdBy = (req.user && (req.user.email || req.user.upn || req.user.name)) || 'unknown';
    const ext = JSON.stringify({ tagColor: color || '#3b82f6' });
    const id = randomUUID();
    // Attach to the synthetic Tags root so all tags live under one tree
    // in the Contexts selector instead of one tag per top-level entry.
    const parentId = await getOrCreateTagRoot(targetType);
    const { rows } = await db.query(
      `INSERT INTO "Contexts"
         (id, variant, "targetType", "contextType", "displayName", "parentContextId", "createdByUser", "extendedAttributes")
       VALUES ($1, 'manual', $2, 'Tag', $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [id, targetType, name.trim(), parentId, createdBy, ext]
    );
    res.status(201).json(tagRowFromContext(rows[0], 0));
  } catch (err) {
    console.error('POST /tags failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Shared guard for the /tags/:id handlers: SQL mode + a valid uuid. Sends the
// 400 and returns null on failure, else the id.
function requireValidTagId(req, res) {
  if (!useSql) { res.status(400).json({ error: 'SQL mode required' }); return null; }
  const id = req.params.id;
  if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid tag ID' }); return null; }
  return id;
}

// PATCH /api/tags/:id
router.patch('/tags/:id', writeTags, async (req, res) => {
  try {
    const id = requireValidTagId(req, res);
    if (id === null) return;

    const { name, color } = req.body;
    if (color && !HEX_COLOR_RE.test(color)) return res.status(400).json({ error: 'color must be a hex value like #3b82f6' });

    const existing = await db.queryOne(
      `SELECT * FROM "Contexts" WHERE id = $1 AND "contextType" = 'Tag'`,
      [id]
    );
    if (!existing) return res.status(404).json({ error: 'Tag not found' });

    const sets = [];
    const params = [];
    if (name) { params.push(name.trim()); sets.push(`"displayName" = $${params.length}`); }
    if (color) {
      const ext = { ...(existing.extendedAttributes || {}), tagColor: color };
      params.push(JSON.stringify(ext));
      sets.push(`"extendedAttributes" = $${params.length}::jsonb`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    const { rows } = await db.query(
      `UPDATE "Contexts" SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json(tagRowFromContext(rows[0]));
  } catch (err) {
    console.error('PATCH /tags failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tags/:id
router.delete('/tags/:id', writeTags, async (req, res) => {
  try {
    const id = requireValidTagId(req, res);
    if (id === null) return;
    await db.query(
      `DELETE FROM "Contexts" WHERE id = $1 AND "contextType" = 'Tag'`,
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /tags failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tags/:id/assign
router.post('/tags/:id/assign', writeTags, async (req, res) => {
  try {
    const id = requireValidTagId(req, res);
    if (id === null) return;
    const { entityIds } = req.body;
    if (!Array.isArray(entityIds) || entityIds.length === 0) return res.status(400).json({ error: 'entityIds array required' });
    if (entityIds.length > 500) return res.status(400).json({ error: 'Maximum 500 entity IDs per request' });

    const ctx = await db.queryOne(
      `SELECT id, "targetType" FROM "Contexts" WHERE id = $1 AND "contextType" = 'Tag'`,
      [id]
    );
    if (!ctx) return res.status(404).json({ error: 'Tag not found' });

    // Normalise each entityId: the UI sends uppercase strings for legacy reasons;
    // ContextMembers stores UUIDs directly.
    const normalised = entityIds
      .map(e => String(e).toLowerCase())
      .filter(e => UUID_RE.test(e));
    if (normalised.length === 0) return res.json({ ok: true, inserted: 0 });

    // One round-trip: unnest a uuid array and ON CONFLICT-skip duplicates.
    const result = await db.query(
      `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
       SELECT $1, $2, eid::uuid, 'analyst'
         FROM unnest($3::text[]) AS t(eid)
       ON CONFLICT ("contextId", "memberId") DO NOTHING`,
      [id, ctx.targetType, normalised]
    );
    await recalcMemberCountsForChain(id);
    res.json({ ok: true, inserted: result.rowCount || 0 });
  } catch (err) {
    console.error('POST /tags/:id/assign failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tags/:id/unassign
router.post('/tags/:id/unassign', writeTags, async (req, res) => {
  try {
    const id = requireValidTagId(req, res);
    if (id === null) return;
    const { entityIds } = req.body;
    if (!Array.isArray(entityIds) || entityIds.length === 0) return res.status(400).json({ error: 'entityIds array required' });
    if (entityIds.length > 500) return res.status(400).json({ error: 'Maximum 500 entity IDs per request' });

    const normalised = entityIds
      .map(e => String(e).toLowerCase())
      .filter(e => UUID_RE.test(e));
    if (normalised.length === 0) return res.json({ ok: true, deleted: 0 });

    const result = await db.query(
      `DELETE FROM "ContextMembers"
         WHERE "contextId" = $1
           AND "memberId" = ANY($2::uuid[])`,
      [id, normalised]
    );
    await recalcMemberCountsForChain(id);
    res.json({ ok: true, deleted: result.rowCount || 0 });
  } catch (err) {
    console.error('POST /tags/:id/unassign failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Users live in Principals (v5); groups/resources in Resources; identities in Identities.
function tableForEntityType(entityType) {
  return entityType === 'user' ? 'Principals'
       : entityType === 'resource' ? 'Resources'
       : entityType === 'identity' ? 'Identities'
       : 'Resources';
}

// Case-insensitive search clause for the bulk-assign filter (`s` is the bound
// placeholder). Users/identities search displayName + email; others + description.
function buildAssignSearchWhere(entityType, alias, s) {
  if (entityType === 'user' || entityType === 'identity') {
    return ` AND (${alias}."displayName" ILIKE ${s} OR ${alias}."email" ILIKE ${s})`;
  }
  return ` AND (${alias}."displayName" ILIKE ${s} OR ${alias}."description" ILIKE ${s})`;
}

// Attribute + reference-field (rel.*) filter clauses for the bulk-assign query.
async function buildAssignFilterWhere(entityType, filters, alias, bind, p) {
  const relFilters = extractRelFilters(filters);
  const cols = entityType === 'user' ? await getPrincipalOrUserColumns(p)
             : entityType === 'resource' ? await getResourceCols(p)
             : await getGroupCols(p);
  const colNames = new Set(cols.map(c => c.name));
  return buildFilterWhere(filters, colNames, alias, bind)
       + buildRelationshipWhere(relFilters, storeForEntityType(entityType), alias);
}

// ─── POST /api/tags/:id/assign-by-filter ──────────────────────────
// Bulk-assign: tags ALL entities matching a search filter (server-side)
router.post('/tags/:id/assign-by-filter', writeTags, async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });
    const { entityType, search: rawSearch, filters } = req.body;
    if (!entityType) return res.status(400).json({ error: 'entityType required' });

    const p = await db.getPool();
    await ensureTagTables(p);
    const tagId = req.params.id;
    if (!UUID_RE.test(tagId)) return res.status(400).json({ error: 'Invalid tag ID' });

    // Resolve the tag's targetType for the INSERT below.
    const ctx = await db.queryOne(
      `SELECT id, "targetType" FROM "Contexts" WHERE id = $1 AND "contextType" = 'Tag'`,
      [tagId]
    );
    if (!ctx) return res.status(404).json({ error: 'Tag not found' });
    const table = tableForEntityType(entityType);
    const alias = 'e';
    const search = (rawSearch || '').trim().slice(0, 200);

    const { params, bind } = createParams();
    const tagIdPh = bind(tagId);
    let where = '1=1';
    // ILIKE for case-insensitive search; camelCase columns are double-quoted.
    if (search) where += buildAssignSearchWhere(entityType, alias, bind(`%${search}%`));

    // Reference-field (rel.*) filters MUST be applied too: bulk-tag re-runs the
    // list's filter set, so a dropped rel.* constraint would silently over-tag.
    if (filters && typeof filters === 'object') {
      where += await buildAssignFilterWhere(entityType, filters, alias, bind, p);
    }

    // Tags now live in Contexts — write directly to ContextMembers, skipping
    // dupes via ON CONFLICT. INSERT count comes back as pg's rowCount.
    const memberTypePh = bind(ctx.targetType);
    const result = await db.query(`
      INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
      SELECT ${tagIdPh}, ${memberTypePh}, ${alias}.id::uuid, 'analyst'
        FROM "${table}" ${alias}
       WHERE (${where})
      ON CONFLICT ("contextId", "memberId") DO NOTHING
    `, params);
    await recalcMemberCountsForChain(tagId);
    res.json({ ok: true, inserted: result.rowCount || 0 });
  } catch (err) {
    console.error('POST /tags/:id/assign-by-filter failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
