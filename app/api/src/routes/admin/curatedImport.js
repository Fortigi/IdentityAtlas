// Import-side helpers for POST /api/admin/import/curated, extracted from
// admin/curatedData.js so the handler (which was cyclomatic 30 / cognitive 46)
// and importCuratedTag (cognitive 22) stay under the complexity threshold. The
// colour default is pure and unit-tested directly; the DB-bound helpers are
// covered through admin.coverage.test.js + curatedData.contract.test.js. All
// SQL is moved verbatim. Persistence targets the base Contexts / ContextMembers
// tables (GraphTags/GraphTagAssignments are read-only views), exactly as
// routes/tags.js does.

import * as db from '../../db/connection.js';

// Colour validation shared by the curated import handlers.
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Pure: a valid #rrggbb colour, or the default blue.
export function normalizeCuratedColor(color) {
  return HEX_COLOR_RE.test(color || '') ? color : '#3b82f6';
}

// Resolve an entity GUID: exact-id match first, then soft-match by displayName
// (+ resourceType for group/resource). Returns { id, softMatched } or null.
export async function resolveEntity(entityId, entityType, displayName, resourceType) {
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

// Upsert the tag (name unique per targetType): update colour if it exists, else
// create it under the Tag root. Returns the tag id (or undefined on failure).
async function upsertCuratedTag(deps, targetType, name, color, stats) {
  const { getOrCreateTagRoot, randomUUID, createdBy } = deps;
  const existingTag = await db.queryOne(
    `SELECT id FROM "Contexts"
       WHERE "contextType" = 'Tag' AND "variant" = 'manual'
         AND "targetType" = $1 AND "displayName" = $2`,
    [targetType, name]
  );
  if (existingTag) {
    await db.query(
      `UPDATE "Contexts"
          SET "extendedAttributes" = COALESCE("extendedAttributes", '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [existingTag.id, JSON.stringify({ tagColor: color })]
    );
    stats.tagsSkipped++;
    return existingTag.id;
  }
  const parentId = await getOrCreateTagRoot(targetType);
  const ins = await db.query(
    `INSERT INTO "Contexts"
       (id, variant, "targetType", "contextType", "displayName", "parentContextId", "createdByUser", "extendedAttributes")
     VALUES ($1, 'manual', $2, 'Tag', $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [randomUUID(), targetType, name, parentId, createdBy, JSON.stringify({ tagColor: color })]
  );
  const tagId = ins.rows[0]?.id;
  if (tagId) stats.tagsInserted++;
  return tagId;
}

// Resolve + attach each of the tag's assignments as a ContextMember. Returns
// true if at least one member was inserted (so the caller recalcs counts).
async function attachTagAssignments(deps, tag, targetType, tagId, stats) {
  const { UUID_RE } = deps;
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
  return assignedAny;
}

// Import one curated tag and its assignments into Contexts / ContextMembers.
// `deps` carries the handler-local bindings (dynamic imports + createdBy).
export async function importCuratedTag(tag, deps, stats) {
  const { ENTITY_TO_TARGET, recalcMemberCountsForChain } = deps;
  if (!tag.name || !tag.entityType) return;
  const targetType = ENTITY_TO_TARGET[tag.entityType];
  if (!targetType) { stats.tagsSkipped++; return; }
  const name = String(tag.name).trim().slice(0, 100);
  if (!name) { stats.tagsSkipped++; return; }
  const color = normalizeCuratedColor(tag.color);

  const tagId = await upsertCuratedTag(deps, targetType, name, color, stats);
  if (!tagId) return;

  const assignedAny = await attachTagAssignments(deps, tag, targetType, tagId, stats);
  if (assignedAny) await recalcMemberCountsForChain(tagId);
}

// Resolve one category → access-package assignment (GUID then soft-match) and
// insert it, updating stats.
async function importCategoryAssignment(a, catId, stats) {
  if (!a.accessPackageId) return;

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

  if (!apId) { stats.catAssignNotFound++; return; }

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

// Upsert one category (name unique) and import each of its AP assignments.
export async function importCuratedCategory(cat, stats) {
  if (!cat.name) return;
  const color = normalizeCuratedColor(cat.color);

  const catUp = await db.query(
    `INSERT INTO "GovernanceCategories" (name, color)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color
     RETURNING id`,
    [String(cat.name).slice(0, 100), color]
  );
  const catId = catUp.rows[0]?.id;
  if (!catId) return;
  stats.catsInserted++;

  for (const a of (cat.assignments || [])) {
    await importCategoryAssignment(a, catId, stats);
  }
}
