// Curated-data export/import endpoints — /api/admin/export/curated and
// /api/admin/import/curated (the PowerShell Export-/Import-FGCuratedData format).
//
// Extracted verbatim from routes/admin.js (audit finding C1). Mounted by
// routes/admin.js via router.use(), so the public paths are unchanged. Pure
// code move — the only adjustment is the dynamic-import paths, which shift one
// level deeper now that this lives under admin/.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { requirePermission } from '../../middleware/auth.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

const exportBulk = requirePermission('data.export.ui');
const writeCsv   = requirePermission('admin.csv-import');

// ── Helpers ──────────────────────────────────────────────────────

async function tableExists(_pool, tableName) {
  // Postgres: use to_regclass() instead of OBJECT_ID. Returns NULL when the
  // table doesn't exist, otherwise the OID. The script translation broke the
  // template literal interpolation here — restored manually.
  const r = await db.query(
    `SELECT to_regclass($1) AS oid`,
    ['"' + tableName + '"']
  );
  return r.rows[0].oid !== null;
}

// Colour validation shared by the curated import + category handlers.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Import one curated tag and its assignments into Contexts / ContextMembers.
// Extracted from POST /admin/import/curated to keep that handler within its
// complexity budget and to make the tag path independently testable. `deps`
// carries the handler-local bindings (dynamic imports + the pool-bound
// resolveEntity closure); persistence uses the module-level db pool.
// GraphTags / GraphTagAssignments are read-only views, so writes target the
// base Contexts / ContextMembers tables directly, exactly as routes/tags.js does.
async function importCuratedTag(tag, deps, stats) {
  const { ENTITY_TO_TARGET, UUID_RE, resolveEntity, getOrCreateTagRoot, recalcMemberCountsForChain, randomUUID, createdBy } = deps;
  if (!tag.name || !tag.entityType) return;
  const targetType = ENTITY_TO_TARGET[tag.entityType];
  if (!targetType) { stats.tagsSkipped++; return; }
  const name = String(tag.name).trim().slice(0, 100);
  if (!name) { stats.tagsSkipped++; return; }
  const color = HEX_COLOR_RE.test(tag.color || '') ? tag.color : '#3b82f6';

  // Upsert the tag (name unique per targetType — the old UQ_GraphTags_Name_Type
  // constraint): update colour if it exists, else create it under the Tag root.
  let tagId;
  const existingTag = await db.queryOne(
    `SELECT id FROM "Contexts"
       WHERE "contextType" = 'Tag' AND "variant" = 'manual'
         AND "targetType" = $1 AND "displayName" = $2`,
    [targetType, name]
  );
  if (existingTag) {
    tagId = existingTag.id;
    await db.query(
      `UPDATE "Contexts"
          SET "extendedAttributes" = COALESCE("extendedAttributes", '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [tagId, JSON.stringify({ tagColor: color })]
    );
    stats.tagsSkipped++;
  } else {
    const parentId = await getOrCreateTagRoot(targetType);
    const ins = await db.query(
      `INSERT INTO "Contexts"
         (id, variant, "targetType", "contextType", "displayName", "parentContextId", "createdByUser", "extendedAttributes")
       VALUES ($1, 'manual', $2, 'Tag', $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [randomUUID(), targetType, name, parentId, createdBy, JSON.stringify({ tagColor: color })]
    );
    tagId = ins.rows[0]?.id;
    if (!tagId) return;
    stats.tagsInserted++;
  }

  // Resolve + attach each assignment as a ContextMember.
  let assignedAny = false;
  for (const a of (tag.assignments || [])) {
    if (!a.entityId) continue;
    const resolved = await resolveEntity(a.entityId, tag.entityType, a.displayName, a.resourceType);
    if (!resolved) { stats.assignmentsNotFound++; continue; }
    // ContextMembers.memberId is a uuid column; a non-uuid id can't be a member,
    // so skip it rather than let the ::uuid cast abort the import.
    const memberId = String(resolved.id).toLowerCase();
    if (!UUID_RE.test(memberId)) { stats.assignmentsNotFound++; continue; }
    const ins = await db.query(
      `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
       VALUES ($1, $2, $3::uuid, 'analyst')
       ON CONFLICT ("contextId", "memberId") DO NOTHING
       RETURNING 1 AS inserted`,
      [tagId, targetType, memberId]
    );
    if (ins.rows.length > 0) {
      assignedAny = true;
      stats.assignmentsInserted++;
      if (resolved.softMatched) stats.assignmentsSoftMatched++;
    } else {
      stats.assignmentsSkipped++;
    }
  }
  if (assignedAny) await recalcMemberCountsForChain(tagId);
}
// ── GET /api/admin/export/curated ────────────────────────────────
// Exports tags (with assignments) and categories (with AP assignments) to JSON.
// Compatible with the PowerShell Export-FGCuratedData / Import-FGCuratedData format.
router.get('/admin/export/curated', exportBulk, async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

  try {
    const pool = await db.getPool();

    // ── Tags + assignments ────────────────────────────────────────
    let tags = [];
    if (await tableExists(pool, 'GraphTags')) {
      // Postgres: tag entityIds are stored as text. Cast to uuid only when the
      // value is shaped like a uuid, otherwise the cast errors out and breaks
      // the whole query. uuid_or_null() is a tiny inline plpgsql helper.
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

      // Group into tag objects
      const byId = new Map();
      for (const row of tagRows.rows) {
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
      tags = Array.from(byId.values());
    }

    // ── Categories + AP assignments ───────────────────────────────
    let categories = [];
    if (await tableExists(pool, 'GovernanceCategories')) {
      const catRows = await db.query(`
        SELECT c.id, c.name, c.color, ca."resourceId", ap."displayName" AS "businessRoleDisplayName"
        FROM "GovernanceCategories" c
        LEFT JOIN "GovernanceCategoryAssignments" ca ON ca."categoryId" = c.id
        LEFT JOIN "Resources" ap
          ON LOWER(ap.id::text) = LOWER(ca."resourceId")
          AND ap."resourceType" = 'BusinessRole'
        ORDER BY c.name, ca."resourceId"
      `);

      const byCatId = new Map();
      for (const row of catRows.rows) {
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
      categories = Array.from(byCatId.values());
    }

    const payload = {
      exportedAt:       new Date().toISOString(),
      version:          '1.0',
      tags,
      categories,
      analystOverrides: [],   // not managed via UI — exported by PowerShell only
    };

    res.setHeader('Content-Disposition', `attachment; filename="FGCuratedData_${new Date().toISOString().slice(0,10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('Export curated data failed:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── POST /api/admin/import/curated ───────────────────────────────
// Imports tags and categories from a JSON file (same format as export).
// Strategy per assignment:
//   1. GUID match — look up entityId / accessPackageId directly.
//   2. Soft-match — if GUID not found, search by displayName
//      (+ resourceType for group/resource entities).
// Skips assignments whose entity cannot be resolved in either way.
router.post('/admin/import/curated', writeCsv, async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

  const { tags = [], categories = [] } = req.body;
  if (!Array.isArray(tags) || !Array.isArray(categories)) {
    return res.status(400).json({ error: 'tags and categories must be arrays' });
  }

  const stats = {
    tagsInserted: 0, tagsSkipped: 0,
    assignmentsInserted: 0, assignmentsSkipped: 0,
    assignmentsSoftMatched: 0, assignmentsNotFound: 0,
    catsInserted: 0, catsSkipped: 0,
    catAssignInserted: 0, catAssignSkipped: 0,
    catAssignSoftMatched: 0, catAssignNotFound: 0,
  };

  try {
    const pool = await db.getPool();

    // Ensure tag + category tables exist
    const { ensureTagTables, ENTITY_TO_TARGET, UUID_RE } = await import('../tags.js');
    const { ensureCategoryTables } = await import('../categories.js');
    const { getOrCreateTagRoot }         = await import('../../bootstrap.js');
    const { recalcMemberCountsForChain } = await import('../../contexts/memberCounts.js');
    const { randomUUID }                 = await import('crypto');
    await ensureTagTables(pool);
    await ensureCategoryTables(pool);

    // ── Helper: resolve entity GUID ──────────────────────────────
    // NB: no temporal (ValidTo) filter — the SQL-Server-era system-versioned
    // columns were dropped in the postgres migration, so a `ValidTo` predicate
    // here throws "column does not exist", which the catch swallowed, making
    // every lookup silently miss (all assignments landed as "not found").
    async function resolveEntity(entityId, entityType, displayName, resourceType) {
      // 1. GUID match — check if the entity still exists with this ID
      let exists = false;
      try {
        const tbl = entityType === 'user' ? 'Principals' : 'Resources';
        const r = await db.query(
          `SELECT COUNT(*) AS n FROM "${tbl}" WHERE UPPER((id)::text) = UPPER($1)`,
          [entityId],
        );
        exists = r.rows[0].n > 0;
      } catch { /* table might not exist */ }

      if (exists) return { id: entityId.toUpperCase(), softMatched: false };

      // 2. Soft-match by displayName (+ resourceType for resources/groups)
      if (!displayName) return null;
      try {
        if (entityType === 'user') {
          const tbl = 'Principals';
          const r = await db.query(
            `SELECT UPPER((id)::text) AS id FROM "${tbl}"
                    WHERE "displayName" = $1`,
            [displayName],
          );
          if (r.rows.length > 0) return { id: r.rows[0].id, softMatched: true };
        } else {
          // group / resource — match on displayName + resourceType if available
          const tbl = 'Resources';
          const params = [displayName];
          let rtClause = '';
          if (resourceType) {
            params.push(resourceType);
            rtClause = 'AND "resourceType" = $2';
          }
          const r = await db.query(
            `SELECT UPPER((id)::text) AS id FROM "${tbl}"
             WHERE "displayName" = $1 ${rtClause}`,
            params,
          );
          if (r.rows.length > 0) return { id: r.rows[0].id, softMatched: true };
        }
      } catch { /* ignore */ }

      return null; // not found
    }

    // ── Tags ─────────────────────────────────────────────────────
    // Per-tag work lives in importCuratedTag() (module scope) to keep this
    // handler within its complexity budget. Hand it the handler-local bindings.
    const tagDeps = {
      ENTITY_TO_TARGET, UUID_RE, resolveEntity, getOrCreateTagRoot,
      recalcMemberCountsForChain, randomUUID,
      createdBy: (req.user && (req.user.email || req.user.upn || req.user.name)) || 'import',
    };
    for (const tag of tags) await importCuratedTag(tag, tagDeps, stats);

    // ── Categories ───────────────────────────────────────────────
    for (const cat of categories) {
      if (!cat.name) continue;
      const color = HEX_COLOR_RE.test(cat.color || '') ? cat.color : '#3b82f6';

      // Upsert category (name is unique)
      const catUp = await db.query(
        `INSERT INTO "GovernanceCategories" (name, color)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color
         RETURNING id`,
        [String(cat.name).slice(0, 100), color]
      );
      const catId = catUp.rows[0]?.id;
      if (!catId) continue;
      stats.catsInserted++;

      for (const a of (cat.assignments || [])) {
        if (!a.accessPackageId) continue;

        // 1. GUID match
        let apId = null;
        try {
          const r = await db.query(
            `SELECT LOWER(id::text) AS id FROM "Resources"
              WHERE LOWER(id::text) = $1 AND "resourceType" = 'BusinessRole'`,
            [a.accessPackageId.toLowerCase()]
          );
          if (r.rows.length > 0) apId = r.rows[0].id;
        } catch { /* ignore */ }

        let softMatched = false;
        if (!apId && a.accessPackageDisplayName) {
          try {
            const r = await db.query(
              `SELECT LOWER(id::text) AS id FROM "Resources"
                WHERE "displayName" = $1 AND "resourceType" = 'BusinessRole'`,
              [a.accessPackageDisplayName]
            );
            if (r.rows.length > 0) { apId = r.rows[0].id; softMatched = true; }
          } catch { /* ignore */ }
        }

        if (!apId) { stats.catAssignNotFound++; continue; }

        // Insert or skip (AP can only have one category — caller must remove first)
        const ins = await db.query(
          `INSERT INTO "GovernanceCategoryAssignments" ("resourceId", "categoryId")
           VALUES ($1, $2)
           ON CONFLICT ("resourceId", "categoryId") DO NOTHING
           RETURNING 1 AS inserted`,
          [apId, catId]
        );
        if (ins.rows.length > 0) {
          stats.catAssignInserted++;
          if (softMatched) stats.catAssignSoftMatched++;
        } else {
          stats.catAssignSkipped++;
        }
      }
    }

    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Import curated data failed:', err.message);
    res.status(500).json({ error: 'Import failed' });
  }
});

export default router;
