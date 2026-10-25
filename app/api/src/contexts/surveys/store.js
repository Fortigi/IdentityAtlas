// Survey templates — the SQL. Every statement the feature runs is here, so the
// contract test (contract-tests/surveyTemplates.contract.test.js) can hold them
// all against a migrated PostgreSQL. Tables: migration 100.
//
// Dates leave PostgreSQL as text ('YYYY-MM-DD'), as in interviews/store.js.

const TEMPLATE_COLUMNS = `t.id, t.key, t.name, t.description, t."contextCategory", t."scopeRootContextId",
       sr."displayName" AS "scopeRootName", t."currentVersion", t."builtIn", t."createdBy", t."createdAt",
       t."updatedAt", t."archivedAt"`;

/** The templates, optionally of one category; archived ones only when asked. With how many requests each has. */
export async function listTemplates(db, { category = null, includeArchived = false } = {}) {
  const r = await db.query(`
    SELECT ${TEMPLATE_COLUMNS},
           (SELECT count(*)::int FROM "SurveyRequests" q WHERE q."templateId" = t.id) AS "requestCount"
      FROM "SurveyTemplates" t
      LEFT JOIN "Contexts" sr ON sr.id = t."scopeRootContextId"
     WHERE ($1::text IS NULL OR t."contextCategory" = $1)
       AND ($2 OR t."archivedAt" IS NULL)
     ORDER BY t.name, t.id`, [category, includeArchived]);
  return r.rows;
}

/** One template with the definition of its current version, or null. */
export async function getTemplate(db, id) {
  return db.queryOne(`
    SELECT ${TEMPLATE_COLUMNS}, v.definition
      FROM "SurveyTemplates" t
      LEFT JOIN "Contexts" sr ON sr.id = t."scopeRootContextId"
      JOIN "SurveyTemplateVersions" v ON v."templateId" = t.id AND v.version = t."currentVersion"
     WHERE t.id = $1`, [id]);
}

export async function listVersions(db, templateId) {
  const r = await db.query(`
    SELECT version, "createdBy", "createdAt" FROM "SurveyTemplateVersions"
     WHERE "templateId" = $1 ORDER BY version DESC`, [templateId]);
  return r.rows;
}

export async function keyExists(db, key) {
  return !!(await db.queryOne(`SELECT 1 AS x FROM "SurveyTemplates" WHERE key = $1`, [key]));
}

export async function insertTemplate(db, row) {
  const r = await db.query(`
    INSERT INTO "SurveyTemplates" (key, name, description, "contextCategory", "scopeRootContextId", "builtIn", "createdBy")
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id`,
  [row.key, row.name, row.description ?? null, row.contextCategory, row.scopeRootContextId ?? null, !!row.builtIn, row.createdBy ?? null]);
  return r.rows[0].id;
}

export async function insertVersion(db, templateId, version, definition, user) {
  await db.query(`
    INSERT INTO "SurveyTemplateVersions" ("templateId", version, definition, "createdBy")
    VALUES ($1, $2, $3::jsonb, $4)`, [templateId, version, JSON.stringify(definition), user ?? null]);
}

/** Change a template's own fields (and point it at a new version). Only the keys given change. */
export async function updateTemplate(db, id, fields) {
  await db.query(`
    UPDATE "SurveyTemplates"
       SET name                 = COALESCE($2, name),
           description          = CASE WHEN $3 THEN $4 ELSE description END,
           "contextCategory"    = COALESCE($5, "contextCategory"),
           "scopeRootContextId" = CASE WHEN $6 THEN $7::uuid ELSE "scopeRootContextId" END,
           "currentVersion"     = COALESCE($8, "currentVersion"),
           "archivedAt"         = CASE WHEN $9 THEN $10::timestamptz ELSE "archivedAt" END,
           "updatedAt"          = now()
     WHERE id = $1`,
  [id, fields.name ?? null, 'description' in fields, fields.description ?? null, fields.contextCategory ?? null,
    'scopeRootContextId' in fields, fields.scopeRootContextId ?? null, fields.currentVersion ?? null,
    'archivedAt' in fields, fields.archivedAt ?? null]);
}

/**
 * The live templates that may be sent about this context: its category, and —
 * when a template is scoped — the context is the scope root or below it.
 */
export async function applicableTemplates(db, contextId) {
  const r = await db.query(`
    WITH RECURSIVE up AS (
      SELECT id, "parentContextId", 0 AS depth FROM "Contexts" WHERE id = $1
      UNION ALL
      SELECT c.id, c."parentContextId", up.depth + 1 FROM "Contexts" c JOIN up ON c.id = up."parentContextId" WHERE up.depth < 50
    )
    SELECT ${TEMPLATE_COLUMNS}
      FROM "SurveyTemplates" t
      LEFT JOIN "Contexts" sr ON sr.id = t."scopeRootContextId"
      JOIN "Contexts" ctx ON ctx.id = $1
     WHERE t."archivedAt" IS NULL
       AND t."contextCategory" = ctx."contextCategory"
       AND (t."scopeRootContextId" IS NULL OR t."scopeRootContextId" IN (SELECT id FROM up))
     ORDER BY t.name, t.id`, [contextId]);
  return r.rows;
}

export async function getContext(db, contextId) {
  return db.queryOne(`
    SELECT id, "displayName", "contextCategory", "targetType", description, "extendedAttributes"
      FROM "Contexts" WHERE id = $1`, [contextId]);
}

/** The context and every context below it of the same category (the tree a survey can be sent down). */
export async function contextTree(db, contextId) {
  const r = await db.query(`
    WITH RECURSIVE down AS (
      SELECT id, 0 AS depth FROM "Contexts" WHERE id = $1
      UNION ALL
      SELECT c.id, down.depth + 1 FROM "Contexts" c JOIN down ON c."parentContextId" = down.id WHERE down.depth < 50
    )
    SELECT c.id, c."displayName", c."contextCategory", down.depth
      FROM down JOIN "Contexts" c ON c.id = down.id
     WHERE c."contextCategory" = (SELECT "contextCategory" FROM "Contexts" WHERE id = $1)
     ORDER BY down.depth, c."displayName", c.id`, [contextId]);
  return r.rows;
}

/** The Accountable of each context — { contextId → { principalId, identityId, displayName } }. */
export async function accountablesOf(db, contextIds) {
  if (contextIds.length === 0) return new Map();
  const r = await db.query(`
    SELECT r."contextId", r."principalId", r."identityId", COALESCE(p."displayName", i."displayName") AS "displayName"
      FROM "ContextRoles" r
      LEFT JOIN "Principals" p ON p.id = r."principalId"
      LEFT JOIN "Identities" i ON i.id = r."identityId"
     WHERE r."contextId" = ANY($1::uuid[]) AND r.role = 'Accountable'`, [contextIds]);
  return new Map(r.rows.map(x => [x.contextId, x]));
}

export async function personName(db, col, id) {
  const table = col === 'principalId' ? 'Principals' : 'Identities';
  const row = await db.queryOne(`SELECT "displayName" FROM "${table}" WHERE id = $1`, [id]);
  return row ? (row.displayName || id) : null;
}

// ─── Requests ────────────────────────────────────────────────────────────
const REQUEST_COLUMNS = `q.id, q."templateId", q."templateVersion", q."contextId", q."principalId", q."identityId",
       q."recipientName", q.language, q.message, q."dueAt"::text AS "dueAt", q.status, q."sentBy", q."sentAt",
       q."openedAt", q."submittedAt", q."submittedBy", q."onBehalf", q."interviewId",
       t.name AS "templateName", ctx."displayName" AS "contextName", ctx."contextCategory"`;
const REQUEST_FROM = `
      FROM "SurveyRequests" q
      JOIN "SurveyTemplates" t ON t.id = q."templateId"
      JOIN "Contexts" ctx ON ctx.id = q."contextId"`;

export async function insertRequests(db, rows) {
  if (rows.length === 0) return [];
  const r = await db.query(`
    INSERT INTO "SurveyRequests"
      ("templateId", "templateVersion", "contextId", "principalId", "identityId", "recipientName", language, message, "dueAt", "sentBy")
    SELECT x."templateId", x."templateVersion", x."contextId", x."principalId", x."identityId", x."recipientName",
           x.language, x.message, x."dueAt", x."sentBy"
      FROM jsonb_to_recordset($1::jsonb) AS x(
           "templateId" uuid, "templateVersion" integer, "contextId" uuid, "principalId" uuid, "identityId" uuid,
           "recipientName" text, language text, message text, "dueAt" date, "sentBy" text)
    RETURNING id, "contextId"`, [JSON.stringify(rows)]);
  return r.rows;
}

/** The requests about one context, newest first. */
export async function listContextRequests(db, contextId) {
  const r = await db.query(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM}
     WHERE q."contextId" = $1 ORDER BY q."sentAt" DESC, q.id`, [contextId]);
  return r.rows;
}

// A request is someone's when it names their account, their person, or another
// account of their person (IdentityMembers) — as context ownership is read.
const MINE = `(q."principalId" = $1::uuid
            OR ($2::uuid IS NOT NULL AND (q."identityId" = $2::uuid
                OR q."principalId" IN (SELECT m."principalId" FROM "IdentityMembers" m WHERE m."identityId" = $2::uuid))))`;

/** The requests sent to a person (any of their accounts), open ones first. */
export async function requestsFor(db, principalId, identityId) {
  const r = await db.query(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM}
     WHERE ${MINE} AND q.status <> 'cancelled'
     ORDER BY (q.status = 'sent') DESC, q."dueAt" NULLS LAST, q."sentAt" DESC`, [principalId, identityId]);
  return r.rows;
}

/** Whether a survey was sent to a person and not withdrawn (the survey-respondent sign-in check). */
export async function hasSurvey(db, principalId, identityId) {
  return !!(await db.queryOne(`SELECT 1 AS x FROM "SurveyRequests" q WHERE ${MINE} AND q.status <> 'cancelled' LIMIT 1`,
    [principalId, identityId]));
}

/** Whether this request is the person's. */
export async function isRecipient(db, requestId, principalId, identityId) {
  return !!(await db.queryOne(`SELECT 1 AS x FROM "SurveyRequests" q WHERE q.id = $3 AND ${MINE}`, [principalId, identityId, requestId]));
}

/** One request with the definition it was sent with and the context it is about; null when there is none. */
export async function getRequest(db, id, { lock = false } = {}) {
  return db.queryOne(`
    SELECT ${REQUEST_COLUMNS}, q.answers, v.definition,
           ctx."targetType", ctx.description AS "contextDescription", ctx."extendedAttributes" AS "contextAttributes"
      ${REQUEST_FROM}
      JOIN "SurveyTemplateVersions" v ON v."templateId" = q."templateId" AND v.version = q."templateVersion"
     WHERE q.id = $1${lock ? ' FOR UPDATE OF q' : ''}`, [id]);
}

export async function saveAnswers(db, id, answers) {
  await db.query(`UPDATE "SurveyRequests" SET answers = $2::jsonb WHERE id = $1 AND status = 'sent'`, [id, JSON.stringify(answers)]);
}

export async function markOpened(db, id) {
  await db.query(`UPDATE "SurveyRequests" SET "openedAt" = now() WHERE id = $1 AND "openedAt" IS NULL`, [id]);
}

export async function markSubmitted(db, id, { answers, interviewId, user, onBehalf, language }) {
  await db.query(`
    UPDATE "SurveyRequests"
       SET status = 'submitted', answers = $2::jsonb, "interviewId" = $3, "submittedBy" = $4, "submittedAt" = now(),
           "onBehalf" = $5, language = COALESCE($6, language)
     WHERE id = $1`, [id, JSON.stringify(answers), interviewId, user ?? null, !!onBehalf, language ?? null]);
}

/** Cancel an unanswered request; the number of rows changed (0: not found or already answered). */
export async function cancelRequest(db, id) {
  const r = await db.query(`UPDATE "SurveyRequests" SET status = 'cancelled' WHERE id = $1 AND status = 'sent'`, [id]);
  return r.rowCount;
}

// ─── Finding a person for a person question ──────────────────────────────
// A respondent may have no Identity Atlas role and so no /api/users: the form
// searches here. Enabled, not deleted, users by name or e-mail; at most `limit`.
export async function searchPeople(db, term, limit = 10) {
  const r = await db.query(`
    SELECT id, "displayName", email, "jobTitle", department
      FROM "Principals"
     WHERE "deletedAt" IS NULL AND "principalType" = 'User'
       AND ("displayName" ILIKE $1 OR email ILIKE $1)
     ORDER BY "displayName", id
     LIMIT $2`, [`%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`, limit]);
  return r.rows;
}

// ─── The rows a per-row question is asked about ──────────────────────────
// A context's SameUnitAs variants, with their kind: "this unit" as its people,
// its accounts or its resources (as interviews/store.js reads LINKED_RESOURCES).
export async function unitVariants(db, contextId) {
  const r = await db.query(`
    SELECT c.id, c."targetType", (c.id = $1) AS self
      FROM "Contexts" c
     WHERE c.id = $1
        OR c.id IN (SELECT CASE WHEN r."contextId" = $1 THEN r."relatedContextId" ELSE r."contextId" END
                      FROM "ContextRelationships" r
                     WHERE r."relationshipType" = 'SameUnitAs' AND $1 IN (r."contextId", r."relatedContextId"))`, [contextId]);
  return r.rows;
}

export const MAX_ROWS = 5000;

export const MEMBER_ROWS_SQL = `
    SELECT cm."memberId" AS id, cm."memberType" AS kind,
           COALESCE(p."displayName", i."displayName") AS "displayName",
           COALESCE(p.email, i.email) AS email, COALESCE(p."jobTitle", i."jobTitle") AS "jobTitle",
           COALESCE(p.department, i.department) AS department, COALESCE(p."companyName", i."companyName") AS "companyName",
           COALESCE(p."employeeId", i."employeeId") AS "employeeId", p."principalType"
      FROM "ContextMembers" cm
      LEFT JOIN "Principals" p ON cm."memberType" = 'Principal' AND p.id = cm."memberId"
      LEFT JOIN "Identities" i ON cm."memberType" = 'Identity' AND i.id = cm."memberId"
     WHERE cm."contextId" = ANY($1::uuid[]) AND cm."memberType" IN ('Principal', 'Identity')
     ORDER BY 3, 1
     LIMIT ${MAX_ROWS}`;

// A resource's owner: who holds its ownership resource (HasOwnership /
// HasAppOwnership, as the crawlers store it), else an owner attribute from its source.
export const RESOURCE_ROWS_SQL = `
    SELECT DISTINCT ON (r.id) r.id, 'Resource' AS kind, r."displayName", r."resourceType", r.description,
           COALESCE(
             (SELECT string_agg(DISTINCT COALESCE(op."displayName", oi."displayName"), ', ')
                FROM "ResourceRelationships" rr
                JOIN "ResourceAssignments" ra ON ra."resourceId" = rr."childResourceId" AND ra."deletedAt" IS NULL
                LEFT JOIN "Principals" op ON op.id = ra."principalId"
                LEFT JOIN "Identities" oi ON oi.id = ra."identityId"
               WHERE rr."parentResourceId" = r.id AND rr."relationshipType" IN ('HasOwnership', 'HasAppOwnership')),
             r."extendedAttributes"->>'owner') AS owner,
           r."extendedAttributes"->>'certificationFrequency' AS "certificationFrequency"
      FROM "ContextMembers" cm
      JOIN "Resources" r ON r.id = cm."memberId"
     WHERE cm."contextId" = ANY($1::uuid[]) AND cm."memberType" = 'Resource'
     ORDER BY r.id
     LIMIT ${MAX_ROWS}`;

export const CHILD_ROWS_SQL = `
    SELECT c.id, 'Context' AS kind, c."displayName", c.description,
           (SELECT COALESCE(p."displayName", i."displayName")
              FROM "ContextRoles" ro
              LEFT JOIN "Principals" p ON p.id = ro."principalId"
              LEFT JOIN "Identities" i ON i.id = ro."identityId"
             WHERE ro."contextId" = c.id AND ro.role = 'Accountable' LIMIT 1) AS accountable
      FROM "Contexts" c
     WHERE c."parentContextId" = ANY($1::uuid[])
     ORDER BY c."displayName", c.id
     LIMIT ${MAX_ROWS}`;

export async function rowsFrom(db, sql, contextIds) {
  return (await db.query(sql, [contextIds])).rows;
}
