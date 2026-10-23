// Context activity — every SQL statement of the feature (migration 096).
//
// Writes: one upload run and its rows, in one transaction that first deletes
// the rows earlier uploads of the same context + source hold for the new
// file's period (re-upload replaces, never doubles); undo of one upload.
// Reads: the context and the sub-units below it, the history, and the
// aggregates the Activity section is built from (report.js composes them).
// Verified against PostgreSQL in contract-tests/contextActivity.contract.test.js;
// the unit tests' database mock is SQL-blind.

export const INSERT_CHUNK = 5_000;
export const MAX_HISTORY = 100;

/** The context an export is uploaded on, or null. */
export async function loadContext(db, id) {
  return db.queryOne(`
    SELECT id, "displayName", "targetType", "contextCategory", "parentContextId"
      FROM "Contexts" WHERE id = $1`, [id]);
}

/** Every context below `id` (all levels): { id, externalId, displayName, parentContextId }. */
export async function descendantsOf(db, id) {
  return (await db.query(`
    WITH RECURSIVE below AS (
      SELECT c.id, c."externalId", c."displayName", c."parentContextId" FROM "Contexts" c WHERE c."parentContextId" = $1
      UNION ALL
      SELECT c.id, c."externalId", c."displayName", c."parentContextId" FROM "Contexts" c JOIN below b ON c."parentContextId" = b.id
    )
    SELECT id, "externalId", "displayName", "parentContextId" FROM below`, [id])).rows;
}

/** The latest upload on this context, of this source when one is named (its mapping starts a re-upload), or null. */
export async function latestUploadOf(db, contextId, sourceLabel = null) {
  return db.queryOne(`
    SELECT id, "sourceLabel", mapping, "fileName", "uploadedAt" FROM "ContextActivityUploads"
     WHERE "contextId" = $1 AND ($2::text IS NULL OR lower("sourceLabel") = lower($2::text))
     ORDER BY "uploadedAt" DESC LIMIT 1`, [contextId, sourceLabel]);
}

/** The rows a new upload of `sourceLabel` on `contextId` for `period` would replace, per earlier upload. */
export async function replacedBy(db, contextId, sourceLabel, period) {
  if (!period) return [];
  return (await db.query(`
    SELECT u.id, u."fileName", u."uploadedAt", count(a.id)::int AS rows
      FROM "ContextActivityUploads" u
      JOIN "ContextActivity" a ON a."uploadId" = u.id
     WHERE u."contextId" = $1 AND lower(u."sourceLabel") = lower($2)
       AND a."activityDate" BETWEEN $3::date AND $4::date
     GROUP BY u.id, u."fileName", u."uploadedAt"
     ORDER BY u."uploadedAt"`, [contextId, sourceLabel, period.start, period.end])).rows;
}

const DELETE_REPLACED = `
  DELETE FROM "ContextActivity" a
   USING "ContextActivityUploads" u
   WHERE a."uploadId" = u.id AND u."contextId" = $1 AND lower(u."sourceLabel") = lower($2)
     AND a."activityDate" BETWEEN $3::date AND $4::date`;

const INSERT_UPLOAD = `
  INSERT INTO "ContextActivityUploads"
    ("contextId", "fileName", "sourceLabel", "mapping", "periodStart", "periodEnd", "rowCount", "matchedRows", "unmatchedRows", "uploadedBy")
  VALUES ($1, $2, $3, $4::jsonb, $5::date, $6::date, $7, $8, $9, $10)
  RETURNING id, "uploadedAt"`;

const INSERT_ROWS = `
  INSERT INTO "ContextActivity"
    ("uploadId", "contextId", "principalId", "identityId", "subjectName", "subjectEmail", "activityDate", "amount", "unit", "kind", "attributes")
  SELECT $1, r."contextId", r."principalId", r."identityId", r."subjectName", r."subjectEmail", r."activityDate", r.amount, $2, r.kind, r.attributes
    FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::date[], $9::numeric[], $10::text[], $11::jsonb[])
         AS r("contextId", "principalId", "identityId", "subjectName", "subjectEmail", "activityDate", amount, kind, attributes)`;

// One chunk as the parallel arrays INSERT_ROWS unnests.
function columnsOf(rows) {
  const pick = (f) => rows.map(r => r[f] ?? null);
  return [pick('contextId'), pick('principalId'), pick('identityId'), pick('subjectName'), pick('subjectEmail'), pick('date'),
    pick('amount'), pick('kind'), rows.map(r => (r.attributes ? JSON.stringify(r.attributes) : null))];
}

/**
 * Write one upload: delete what it replaces, record the run, insert its rows.
 * @param {{tx: Function}} db
 * @param {object} run   { contextId, fileName, sourceLabel, mapping, period, rowCount, matchedRows, unmatchedRows, uploadedBy, unit }
 * @param {object[]} rows  { contextId, principalId, identityId, subjectName, subjectEmail, date, amount, kind, attributes }
 * @returns {Promise<{ uploadId, uploadedAt, replaced, inserted }>}
 */
export async function writeUpload(db, run, rows, chunk = INSERT_CHUNK) {
  return db.tx(async (client) => {
    const replaced = run.period
      ? (await client.query(DELETE_REPLACED, [run.contextId, run.sourceLabel, run.period.start, run.period.end])).rowCount ?? 0
      : 0;
    const head = (await client.query(INSERT_UPLOAD, [
      run.contextId, run.fileName, run.sourceLabel, JSON.stringify(run.mapping), run.period?.start ?? null, run.period?.end ?? null,
      run.rowCount, run.matchedRows, run.unmatchedRows, run.uploadedBy ?? null,
    ])).rows[0];
    for (let i = 0; i < rows.length; i += chunk) {
      await client.query(INSERT_ROWS, [head.id, run.unit, ...columnsOf(rows.slice(i, i + chunk))]);
    }
    return { uploadId: head.id, uploadedAt: head.uploadedAt, replaced, inserted: rows.length };
  });
}

/**
 * The uploads behind a context's activity, newest first: the ones made on it
 * and the ones made on a context above it that put rows on it. `rowsHeld` is
 * what an upload still holds (0 once a later upload replaced all of it),
 * `rowsHere` the part on this context.
 */
export async function listUploads(db, contextId) {
  return (await db.query(`
    SELECT u.id, u."contextId", c."displayName" AS "contextName", u."fileName", u."sourceLabel", u."periodStart", u."periodEnd",
           u."rowCount", u."matchedRows", u."unmatchedRows", u."uploadedBy", u."uploadedAt",
           (SELECT count(*)::int FROM "ContextActivity" a WHERE a."uploadId" = u.id) AS "rowsHeld",
           (SELECT count(*)::int FROM "ContextActivity" a WHERE a."uploadId" = u.id AND a."contextId" = $1) AS "rowsHere"
      FROM "ContextActivityUploads" u
      JOIN "Contexts" c ON c.id = u."contextId"
     WHERE u."contextId" = $1
        OR EXISTS (SELECT 1 FROM "ContextActivity" a WHERE a."uploadId" = u.id AND a."contextId" = $1)
     ORDER BY u."uploadedAt" DESC
     LIMIT ${MAX_HISTORY}`, [contextId])).rows;
}

/** Undo one upload made on this context: the run and (cascade) its rows. Null when there is no such upload. */
export async function deleteUpload(db, contextId, uploadId) {
  return db.queryOne(`
    WITH held AS (SELECT count(*)::int AS n FROM "ContextActivity" WHERE "uploadId" = $2),
         gone AS (DELETE FROM "ContextActivityUploads" WHERE id = $2 AND "contextId" = $1 RETURNING id)
    SELECT gone.id, held.n AS rows FROM gone CROSS JOIN held`, [contextId, uploadId]);
}

// ─── Reads for the Activity section ──────────────────────────────────────

/** The latest activity date on these contexts, or null when they have none. */
export async function latestActivityDate(db, contextIds) {
  const row = await db.queryOne(`
    SELECT to_char(max("activityDate"), 'YYYY-MM-DD') AS latest FROM "ContextActivity" WHERE "contextId" = ANY($1::uuid[])`, [contextIds]);
  return row?.latest ?? null;
}

// One row per (context, subject, month, unit): what report.js folds into people.
const AGGREGATE_COLUMNS = `a."contextId", a."principalId", a."identityId", lower(a."subjectEmail") AS "subjectEmail",
       min(a."subjectName") AS "subjectName", to_char(a."activityDate", 'YYYY-MM') AS month, a.unit,
       sum(a.amount)::float8 AS amount, count(*)::int AS rows,
       to_char(min(a."activityDate"), 'YYYY-MM-DD') AS "firstDate", to_char(max(a."activityDate"), 'YYYY-MM-DD') AS "lastDate"`;
const AGGREGATE_GROUP = `a."contextId", a."principalId", a."identityId", lower(a."subjectEmail"),
       CASE WHEN a."subjectEmail" IS NULL THEN lower(a."subjectName") END, to_char(a."activityDate", 'YYYY-MM'), a.unit`;

/** The aggregated activity on these contexts between two dates (inclusive). */
export async function activityAggregates(db, contextIds, from, to) {
  return (await db.query(`
    SELECT ${AGGREGATE_COLUMNS}
      FROM "ContextActivity" a
     WHERE a."contextId" = ANY($1::uuid[]) AND a."activityDate" BETWEEN $2::date AND $3::date
     GROUP BY ${AGGREGATE_GROUP}`, [contextIds, from, to])).rows;
}

/** The people and accounts that are members of these contexts, with their names. */
export async function personMembersOf(db, contextIds) {
  return (await db.query(`
    SELECT m."contextId", m."memberId", m."memberType", COALESCE(i."displayName", p."displayName") AS "displayName",
           COALESCE(i.email, p.email) AS email
      FROM "ContextMembers" m
      LEFT JOIN "Identities" i ON m."memberType" = 'Identity' AND i.id = m."memberId"
      LEFT JOIN "Principals" p ON m."memberType" = 'Principal' AND p.id = m."memberId"
     WHERE m."contextId" = ANY($1::uuid[]) AND m."memberType" IN ('Identity', 'Principal')`, [contextIds])).rows;
}

/** Display names of matched people and accounts: Map(id → name). */
export async function namesOf(db, identityIds, principalIds) {
  const names = new Map();
  if (identityIds.length) {
    for (const r of (await db.query('SELECT id, "displayName" FROM "Identities" WHERE id = ANY($1::uuid[])', [identityIds])).rows) names.set(r.id, r.displayName);
  }
  if (principalIds.length) {
    for (const r of (await db.query('SELECT id, "displayName" FROM "Principals" WHERE id = ANY($1::uuid[])', [principalIds])).rows) names.set(r.id, r.displayName);
  }
  return names;
}
