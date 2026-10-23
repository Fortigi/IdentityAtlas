// Context upload — the uploaded lists (Systems of type 'Upload') and their runs
// (ContextUploads, migration 095). Every SQL statement of the feature that is not
// an ingest write lives here.

export const UPLOAD_SYSTEM_TYPE = 'Upload';

/** The system's display name for a list: "Klanten" → "Klanten (upload)". */
export const systemNameFor = (listName) => `${listName} (upload)`;

/** One list by its system id, with its latest mapping, or null when it is not an upload list. */
export async function findList(db, systemId) {
  const id = Number(systemId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.queryOne(`
    SELECT s.id, s."displayName", u.mapping, u."fileName", u."uploadedAt", u."rootContextId"
      FROM "Systems" s
      LEFT JOIN LATERAL (
        SELECT mapping, "fileName", "uploadedAt", "rootContextId" FROM "ContextUploads"
         WHERE "systemId" = s.id ORDER BY "uploadedAt" DESC LIMIT 1
      ) u ON TRUE
     WHERE s.id = $1 AND s."systemType" = $2`, [id, UPLOAD_SYSTEM_TYPE]);
}

/** The list whose system carries this list name, or null. */
export async function findListByName(db, listName) {
  const row = await db.queryOne(`
    SELECT id FROM "Systems" WHERE "systemType" = $1 AND "displayName" = $2 AND "tenantId" IS NULL`,
  [UPLOAD_SYSTEM_TYPE, systemNameFor(listName)]);
  return row ? findList(db, row.id) : null;
}

/** Every list with its latest upload, newest first — the re-import picker. */
export async function listLists(db) {
  const r = await db.query(`
    SELECT s.id, s."displayName", u."fileName", u."uploadedAt", u."uploadedBy", u.template, u."rowCount", u."rootContextId",
           (SELECT count(*)::int FROM "ContextUploads" x WHERE x."systemId" = s.id) AS "uploadCount"
      FROM "Systems" s
      JOIN LATERAL (
        SELECT "fileName", "uploadedAt", "uploadedBy", template, "rowCount", "rootContextId" FROM "ContextUploads"
         WHERE "systemId" = s.id ORDER BY "uploadedAt" DESC LIMIT 1
      ) u ON TRUE
     WHERE s."systemType" = $1
     ORDER BY u."uploadedAt" DESC`, [UPLOAD_SYSTEM_TYPE]);
  return r.rows;
}

/** The list's synced contexts as they are now, for the preview's and apply's counts. */
export async function existingContexts(db, systemId) {
  if (!systemId) return [];
  const r = await db.query(`
    SELECT id, "externalId", "displayName", "contextType", "parentContextId", "ownerUserId", "targetType", "extendedAttributes"
      FROM "Contexts" WHERE "scopeSystemId" = $1 AND variant = 'synced'`, [systemId]);
  return r.rows;
}

/** The sync memberships of the given contexts, as context-members records (kept contexts keep them). */
export async function syncMembershipsOf(db, contextIds) {
  if (contextIds.length === 0) return [];
  const r = await db.query(`
    SELECT cm."contextId", cm."memberId", c."targetType" AS "memberType"
      FROM "ContextMembers" cm JOIN "Contexts" c ON c.id = cm."contextId"
     WHERE cm."contextId" = ANY($1::uuid[]) AND cm."addedBy" = 'sync'`, [contextIds]);
  return r.rows.map(m => ({ ...m, addedBy: 'sync' }));
}

export async function recordUpload(db, run) {
  const row = await db.queryOne(`
    INSERT INTO "ContextUploads"
      ("systemId", "rootContextId", "fileName", template, "keyColumn", mapping, "rowCount",
       created, updated, unchanged, removed, "unmatchedMembers", "uploadedBy")
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id, "uploadedAt"`,
  [run.systemId, run.rootContextId, run.fileName, run.template, run.keyColumn, JSON.stringify(run.mapping), run.rowCount,
    run.created, run.updated, run.unchanged, run.removed, run.unmatchedMembers, run.uploadedBy]);
  return row;
}

/**
 * Where a context of an uploaded list came from: its first and latest upload.
 * Null when the system is not an upload list (or has no run). The context page
 * shows these as its provenance line and in More details.
 */
export async function uploadProvenance(db, systemId) {
  if (!systemId) return null;
  const r = await db.query(`
    (SELECT 'first' AS which, "fileName", "uploadedBy", "uploadedAt" FROM "ContextUploads"
      WHERE "systemId" = $1 ORDER BY "uploadedAt" ASC LIMIT 1)
    UNION ALL
    (SELECT 'last' AS which, "fileName", "uploadedBy", "uploadedAt" FROM "ContextUploads"
      WHERE "systemId" = $1 ORDER BY "uploadedAt" DESC LIMIT 1)`, [systemId]);
  const first = r.rows.find(x => x.which === 'first');
  const last = r.rows.find(x => x.which === 'last');
  if (!first || !last) return null;
  return {
    uploadedFrom: first.fileName,
    uploadedAt: first.uploadedAt,
    uploadedBy: first.uploadedBy,
    lastUploadFile: last.fileName,
    lastUploadAt: last.uploadedAt,
    lastUploadBy: last.uploadedBy,
  };
}
