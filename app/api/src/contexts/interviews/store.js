// Context interviews — the SQL. Every statement the feature runs is here, so the
// contract test (contract-tests/contextInterviews.contract.test.js) can hold
// them all against a migrated PostgreSQL; the rest of the feature is pure or
// calls these. Tables: migration 097.
//
// Dates leave PostgreSQL as text ('YYYY-MM-DD'): node-postgres turns a DATE into
// a local-midnight Date, which shifts a day in any timezone west of UTC.

const INTERVIEW_COLUMNS = `iv.id, iv."contextId", iv."principalId", iv."identityId", iv."intervieweeName",
       iv."interviewedAt"::text AS "interviewedAt", iv."fileName", iv.language, iv."extractionStatus",
       iv."extractionMessage", iv."extractionStartedAt", iv.model, iv."createdBy", iv."createdAt"`;

export async function insertInterview(db, row) {
  const r = await db.query(`
    INSERT INTO "ContextInterviews" AS iv
      ("contextId", "principalId", "identityId", "intervieweeName", "interviewedAt", "fileName", transcript, language,
       "extractionStatus", "createdBy")
    VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10)
    RETURNING ${INTERVIEW_COLUMNS}`,
  [row.contextId, row.principalId ?? null, row.identityId ?? null, row.intervieweeName, row.interviewedAt, row.fileName,
    row.transcript, row.language ?? null, row.extractionStatus, row.createdBy ?? null]);
  return r.rows[0];
}

/** The interviews of a context, newest first, each with its claim counts by status. */
export async function listInterviews(db, contextId) {
  const r = await db.query(`
    SELECT ${INTERVIEW_COLUMNS},
           COUNT(c.id) FILTER (WHERE c."claimStatus" = 'proposed')::int              AS proposed,
           COUNT(c.id) FILTER (WHERE c."claimStatus" IN ('confirmed', 'edited'))::int AS confirmed,
           COUNT(c.id) FILTER (WHERE c."claimStatus" = 'rejected')::int              AS rejected
      FROM "ContextInterviews" iv
      LEFT JOIN "ContextClaims" c ON c."interviewId" = iv.id
     WHERE iv."contextId" = $1
     GROUP BY iv.id
     ORDER BY iv."interviewedAt" DESC, iv."createdAt" DESC`, [contextId]);
  return r.rows;
}

/** One interview of a context, with its transcript when asked; null when it is not that context's. */
export async function getInterview(db, contextId, interviewId, { withTranscript = false } = {}) {
  return db.queryOne(`
    SELECT ${INTERVIEW_COLUMNS}${withTranscript ? ', iv.transcript' : ''}
      FROM "ContextInterviews" iv
     WHERE iv.id = $1 AND iv."contextId" = $2`, [interviewId, contextId]);
}

/** What extraction needs: the interview, its transcript, and the context it is about. */
export async function loadForExtraction(db, interviewId) {
  return db.queryOne(`
    SELECT ${INTERVIEW_COLUMNS}, iv.transcript, ctx."displayName" AS "contextName", ctx."contextCategory"
      FROM "ContextInterviews" iv
      JOIN "Contexts" ctx ON ctx.id = iv."contextId"
     WHERE iv.id = $1`, [interviewId]);
}

export async function setExtraction(db, interviewId, { status, message = null, model = null, started = false }) {
  await db.query(`
    UPDATE "ContextInterviews"
       SET "extractionStatus" = $2, "extractionMessage" = $3,
           model = COALESCE($4, model),
           "extractionStartedAt" = CASE WHEN $5 THEN now() ELSE "extractionStartedAt" END
     WHERE id = $1`, [interviewId, status, message, model, started]);
}

export async function deleteInterview(db, contextId, interviewId) {
  const r = await db.query(`DELETE FROM "ContextInterviews" WHERE id = $1 AND "contextId" = $2`, [interviewId, contextId]);
  return r.rowCount;
}

// ─── Claims ──────────────────────────────────────────────────────────────
const CLAIM_SELECT = `
    SELECT c.id, c."interviewId", c."contextId", c."claimKind", c."subjectKind", c."principalId", c."identityId",
           c."subjectName", COALESCE(p."displayName", i."displayName") AS "subjectDisplayName", c."subjectMatch",
           c.attribute, c.value, c."periodFrom"::text AS "periodFrom", c."periodTo"::text AS "periodTo", c."periodText",
           c.quote, c.confidence::float8 AS confidence, c."roleSuggestion", c."claimStatus" AS status, c."proposedBy",
           c."decidedBy", c."decidedAt", c."createdAt",
           (SELECT r.id FROM "ContextRoles" r WHERE r."sourceClaimId" = c.id LIMIT 1) AS "appliedRoleId",
           iv."intervieweeName", iv."interviewedAt"::text AS "interviewedAt", iv."fileName"
      FROM "ContextClaims" c
      JOIN "ContextInterviews" iv ON iv.id = c."interviewId"
      LEFT JOIN "Principals" p ON p.id = c."principalId"
      LEFT JOIN "Identities" i ON i.id = c."identityId"`;

/** The claims of a context in the given statuses, newest interview first. */
export async function listClaims(db, contextId, statuses) {
  const r = await db.query(`${CLAIM_SELECT}
     WHERE c."contextId" = $1 AND c."claimStatus" = ANY($2::text[])
     ORDER BY iv."interviewedAt" DESC, c."createdAt", c.id`, [contextId, statuses]);
  return r.rows;
}

export async function getClaimRow(db, claimId) {
  return db.queryOne(`${CLAIM_SELECT} WHERE c.id = $1`, [claimId]);
}

const CLAIM_INSERT_COLUMNS = ['claimKind', 'subjectKind', 'principalId', 'identityId', 'subjectName', 'subjectMatch', 'attribute',
  'value', 'periodFrom', 'periodTo', 'periodText', 'quote', 'confidence', 'roleSuggestion'];

/** Insert claims of one interview in one statement (jsonb_to_recordset). Returns their ids. */
export async function insertClaims(db, { interviewId, contextId, proposedBy }, claims) {
  if (claims.length === 0) return [];
  const records = claims.map(c => Object.fromEntries(CLAIM_INSERT_COLUMNS.map(k => [k, c[k] ?? null])));
  const r = await db.query(`
    INSERT INTO "ContextClaims"
      ("interviewId", "contextId", "proposedBy", ${CLAIM_INSERT_COLUMNS.map(k => `"${k}"`).join(', ')})
    SELECT $1, $2, $3, x."claimKind", x."subjectKind", x."principalId", x."identityId", x."subjectName", x."subjectMatch",
           x.attribute, x.value, x."periodFrom", x."periodTo", x."periodText", x.quote, x.confidence, x."roleSuggestion"
      FROM jsonb_to_recordset($4::jsonb) AS x(
           "claimKind" text, "subjectKind" text, "principalId" uuid, "identityId" uuid, "subjectName" text, "subjectMatch" text,
           attribute text, value text, "periodFrom" date, "periodTo" date, "periodText" text, quote text,
           confidence numeric, "roleSuggestion" text)
    RETURNING id`, [interviewId, contextId, proposedBy, JSON.stringify(records)]);
  return r.rows.map(x => x.id);
}

/** A re-run replaces the model's undecided claims; decided ones and an analyst's stay. */
export async function deleteProposedModelClaims(db, interviewId) {
  await db.query(`DELETE FROM "ContextClaims" WHERE "interviewId" = $1 AND "claimStatus" = 'proposed' AND "proposedBy" = 'model'`, [interviewId]);
}

/** Every claim of an interview that a re-run must not propose again. */
export async function keptClaims(db, interviewId) {
  const r = await db.query(`
    SELECT "claimKind", "subjectName", attribute, value FROM "ContextClaims"
     WHERE "interviewId" = $1 AND ("claimStatus" <> 'proposed' OR "proposedBy" = 'analyst')`, [interviewId]);
  return r.rows;
}

/** The current Accountable of a context, or null. Runs inside a transaction too (query only). */
export async function currentAccountable(db, contextId) {
  const r = await db.query(`
    SELECT r.id, r."principalId", r."identityId", r."addedBy", COALESCE(p."displayName", i."displayName") AS "displayName"
      FROM "ContextRoles" r
      LEFT JOIN "Principals" p ON p.id = r."principalId"
      LEFT JOIN "Identities" i ON i.id = r."identityId"
     WHERE r."contextId" = $1 AND r.role = 'Accountable'`, [contextId]);
  return r.rows[0] ?? null;
}

export const HOLDER_COLUMNS = Object.freeze(['principalId', 'identityId']);

/** Contexts whose interviews mention an account or a person in claims of the given statuses, most recent first. */
export async function mentionsOf(db, holderCol, holderId, statuses) {
  if (!HOLDER_COLUMNS.includes(holderCol)) throw new Error(`unknown holder column ${holderCol}`);
  const r = await db.query(`
    SELECT ctx.id AS "contextId", ctx."displayName" AS "contextName", ctx."contextCategory",
           COUNT(*)::int AS claims, MAX(iv."interviewedAt")::text AS "lastInterviewedAt"
      FROM "ContextClaims" c
      JOIN "ContextInterviews" iv ON iv.id = c."interviewId"
      JOIN "Contexts" ctx ON ctx.id = c."contextId"
     WHERE c."${holderCol}" = $1 AND c."claimStatus" = ANY($2::text[])
     GROUP BY ctx.id, ctx."displayName", ctx."contextCategory"
     ORDER BY MAX(iv."interviewedAt") DESC, ctx."displayName"`, [holderId, statuses]);
  return r.rows;
}
