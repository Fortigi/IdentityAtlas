// Context interviews — the SQL. Every statement the feature runs is here, so the
// contract test (contract-tests/contextInterviews.contract.test.js) can hold
// them all against a migrated PostgreSQL; the rest of the feature is pure or
// calls these. Tables: migration 099 (and 100: relevance, quote offsets, two more kinds).
//
// Dates leave PostgreSQL as text ('YYYY-MM-DD'): node-postgres turns a DATE into
// a local-midnight Date, which shifts a day in any timezone west of UTC.

import { normalizedNameSql } from '../../lib/nameMatch.js';

// An "interview" record is any source added to the page (Add information): an
// interview (someone said it — the interviewee is set), a file nobody in
// particular said (a list, notes, a document: no interviewee), or pasted text
// (stored under this file name). The kind is read from those columns, no column
// of its own: 'interview' | 'file' | 'text'.
export const PASTED_TEXT_NAME = 'Pasted text';
export const SOURCE_KIND_SQL = `CASE WHEN iv."fileName" = '${PASTED_TEXT_NAME}' THEN 'text'
       WHEN iv."principalId" IS NULL AND iv."identityId" IS NULL THEN 'file' ELSE 'interview' END`;

const INTERVIEW_COLUMNS = `iv.id, iv."contextId", iv."principalId", iv."identityId", iv."intervieweeName",
       iv."interviewedAt"::text AS "interviewedAt", iv."fileName", iv.language, iv."extractionStatus",
       iv."extractionMessage", iv."extractionStartedAt", iv.model, iv."createdBy", iv."createdAt",
       ${SOURCE_KIND_SQL} AS "sourceKind"`;

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
    SELECT ${INTERVIEW_COLUMNS}, iv.transcript, ctx."displayName" AS "contextName", ctx."contextCategory",
           ctx."extendedAttributes"->'aliases' AS "contextAliases"
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
           c.quote, c."quoteStart", c."quoteEnd", c.confidence::float8 AS confidence, c.relevance,
           c."roleSuggestion", c."claimStatus" AS status, c."proposedBy",
           c."decidedBy", c."decidedAt", c."createdAt",
           (SELECT r.id FROM "ContextRoles" r WHERE r."sourceClaimId" = c.id LIMIT 1) AS "appliedRoleId",
           iv."intervieweeName", iv."interviewedAt"::text AS "interviewedAt", iv."fileName",
           ${SOURCE_KIND_SQL} AS "sourceKind"
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
  'value', 'periodFrom', 'periodTo', 'periodText', 'quote', 'confidence', 'roleSuggestion', 'relevance', 'quoteStart', 'quoteEnd'];

/** Insert claims of one interview in one statement (jsonb_to_recordset). Returns their ids. */
export async function insertClaims(db, { interviewId, contextId, proposedBy }, claims) {
  if (claims.length === 0) return [];
  const records = claims.map(c => Object.fromEntries(CLAIM_INSERT_COLUMNS.map(k => [k, c[k] ?? null])));
  const r = await db.query(`
    INSERT INTO "ContextClaims"
      ("interviewId", "contextId", "proposedBy", ${CLAIM_INSERT_COLUMNS.map(k => `"${k}"`).join(', ')})
    SELECT $1, $2, $3, x."claimKind", x."subjectKind", x."principalId", x."identityId", x."subjectName", x."subjectMatch",
           x.attribute, x.value, x."periodFrom", x."periodTo", x."periodText", x.quote, x.confidence, x."roleSuggestion",
           x.relevance, x."quoteStart", x."quoteEnd"
      FROM jsonb_to_recordset($4::jsonb) AS x(
           "claimKind" text, "subjectKind" text, "principalId" uuid, "identityId" uuid, "subjectName" text, "subjectMatch" text,
           attribute text, value text, "periodFrom" date, "periodTo" date, "periodText" text, quote text,
           confidence numeric, "roleSuggestion" text, relevance text, "quoteStart" integer, "quoteEnd" integer)
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

/** Every decided claim of a context (any interview): a re-extraction must not propose one again, a rejected one included. */
export async function decidedClaims(db, contextId) {
  const r = await db.query(`
    SELECT "claimKind", "subjectName", "principalId", "identityId", attribute, value FROM "ContextClaims"
     WHERE "contextId" = $1 AND "claimStatus" IN ('confirmed', 'edited', 'rejected')`, [contextId]);
  return r.rows;
}

/**
 * Which of `names` (normalised as lib/nameMatch.js does) is the display name or
 * an alias of ANOTHER context. Returns those names.
 */
export async function otherContextNames(db, contextId, names) {
  if (names.length === 0) return [];
  const r = await db.query(`
    SELECT DISTINCT n.name
      FROM unnest($2::text[]) AS n(name)
      JOIN "Contexts" c ON c.id <> $1
       AND (${normalizedNameSql('c."displayName"')} = n.name
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                         CASE WHEN jsonb_typeof(c."extendedAttributes"->'aliases') = 'array'
                              THEN c."extendedAttributes"->'aliases' ELSE '[]'::jsonb END) AS a(v)
                        WHERE ${normalizedNameSql('a.v')} = n.name))`, [contextId, names]);
  return r.rows.map(x => x.name);
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

// ─── Several claims at once ──────────────────────────────────────────────
// Rejects the context's proposed claims of one kind and/or one relevance tier
// in one statement ("Reject all less relevant", "Reject all descriptions"). A
// claim without a tier (from before tiers existed) counts as high.
export async function rejectProposed(db, contextId, { kind = null, relevance = null }, user) {
  const r = await db.query(`
    UPDATE "ContextClaims"
       SET "claimStatus" = 'rejected', "decidedBy" = $4, "decidedAt" = now()
     WHERE "contextId" = $1 AND "claimStatus" = 'proposed'
       AND ($2::text IS NULL OR "claimKind" = $2)
       AND ($3::text IS NULL OR COALESCE(relevance, 'high') = $3)
    RETURNING id`, [contextId, kind, relevance, user]);
  return r.rows.map(x => x.id);
}

/** Every claim of an interview that has a quote, with the offsets stored for it (the transcript view). */
export async function interviewQuotes(db, interviewId) {
  const r = await db.query(`
    SELECT id, quote, "quoteStart", "quoteEnd" FROM "ContextClaims" WHERE "interviewId" = $1 AND quote IS NOT NULL`, [interviewId]);
  return r.rows;
}

// ─── What the sources say about people, for the People overview ──────────
// The person claims (role, roleHistory, membership) of a context, set-based: one
// statement for every claim, one for the people they are about (people.js,
// peopleLoad.js).
const PERSON_CLAIM_COLUMNS = `c.id, c."interviewId", c."claimKind", c.attribute, c.value,
           c."periodFrom"::text AS "periodFrom", c."periodTo"::text AS "periodTo", c."periodText", c.quote,
           c."claimStatus" AS status, c."createdAt", c."subjectName", c."principalId", c."identityId", c."roleSuggestion",
           iv."intervieweeName", iv."interviewedAt"::text AS "interviewedAt", iv."fileName", ${SOURCE_KIND_SQL} AS "sourceKind"`;
export const PERSON_CLAIM_KINDS = Object.freeze(['role', 'roleHistory', 'membership']);

// The holder a claim is about, in the context's own kind of member: the account
// (a unit of accounts) or the person (a unit of people). A claim that names the
// other kind is mapped through IdentityMembers — for a unit of accounts, to the
// person's account that the unit lists. A context of other members has none.
const HOLDER_SQL = Object.freeze({
  Principal: `COALESCE(c."principalId", (SELECT im."principalId" FROM "IdentityMembers" im
                 JOIN "ContextMembers" cm ON cm."contextId" = c."contextId" AND cm."memberId" = im."principalId"
                WHERE im."identityId" = c."identityId" ORDER BY im."principalId" LIMIT 1))`,
  Identity: `COALESCE(c."identityId", (SELECT im."identityId" FROM "IdentityMembers" im
                WHERE im."principalId" = c."principalId" ORDER BY im."identityId" LIMIT 1))`,
  other: 'NULL::uuid',
});

/** Every person claim of a context, with its holder (holderId) in the context's kind of member. */
export function personClaimsSql(targetType) {
  return `
    SELECT ${PERSON_CLAIM_COLUMNS}, COALESCE(p."displayName", i."displayName") AS "subjectDisplayName",
           (p."deletedAt" IS NOT NULL) AS "accountDeleted", ${HOLDER_SQL[targetType] ?? HOLDER_SQL.other} AS "holderId"
      FROM "ContextClaims" c
      JOIN "ContextInterviews" iv ON iv.id = c."interviewId"
      LEFT JOIN "Principals" p ON p.id = c."principalId"
      LEFT JOIN "Identities" i ON i.id = c."identityId"
     WHERE c."contextId" = $1 AND c."claimKind" = ANY($2::text[]) AND c."claimStatus" = ANY($3::text[])`;
}

export async function personClaims(db, contextId, targetType, statuses) {
  return (await db.query(personClaimsSql(targetType), [contextId, PERSON_CLAIM_KINDS, statuses])).rows;
}

// The holders the claims name, and everyone a decision marked former: their row,
// whether the context lists them, and the decision (ContextMemberOverrides,
// migration 101). One statement for all of them.
const HOLDER_ROW = Object.freeze({
  Principal: { table: 'Principals', columns: 'm.id AS "principalId", m.email, m."jobTitle", m."principalType", m."accountEnabled", (m."deletedAt" IS NOT NULL) AS "accountDeleted"' },
  Identity: { table: 'Identities', columns: 'm.id AS "identityId", m.email, m."jobTitle", m.department' },
});

export function holderRowsSql(targetType) {
  const h = HOLDER_ROW[targetType];
  if (!h) return null;
  return `
    SELECT m.id, m."displayName", ${h.columns},
           EXISTS (SELECT 1 FROM "ContextMembers" cm WHERE cm."contextId" = $1 AND cm."memberId" = m.id) AS listed,
           o."claimId" AS "overrideClaimId", o.overrides AS "overrideSource", o."decidedBy" AS "overrideBy", o."decidedAt" AS "overrideAt"
      FROM "${h.table}" m
      LEFT JOIN "ContextMemberOverrides" o ON o."contextId" = $1 AND o."memberId" = m.id
     WHERE m.id = ANY($2::uuid[])
        OR m.id IN (SELECT x."memberId" FROM "ContextMemberOverrides" x WHERE x."contextId" = $1)`;
}

/** The rows of the given holders and of the context's former-marked members; [] for a context of other members. */
export async function holderRows(db, contextId, targetType, ids) {
  const sql = holderRowsSql(targetType);
  return sql ? (await db.query(sql, [contextId, ids])).rows : [];
}

// The resources "this application" means: the members of this context when it
// holds resources, and of every SameUnitAs variant that holds resources.
const LINKED_RESOURCES = `
    SELECT cm."memberId" AS "resourceId"
      FROM "ContextMembers" cm
      JOIN "Contexts" x ON x.id = cm."contextId" AND x."targetType" = 'Resource'
     WHERE cm."memberType" = 'Resource'
       AND cm."contextId" IN (
             SELECT $1::uuid
             UNION
             SELECT CASE WHEN r."contextId" = $1 THEN r."relatedContextId" ELSE r."contextId" END
               FROM "ContextRelationships" r
              WHERE r."relationshipType" = 'SameUnitAs' AND $1 IN (r."contextId", r."relatedContextId"))`;

// Live entitlements (ResourceAssignments not deleted) per account and per person
// — a person's own and those of their accounts — and how many of them are on
// the linked resources. One statement for every previous member at once.
export const ENTITLEMENT_COUNTS_SQL = `
    WITH linked AS (${LINKED_RESOURCES}),
    held AS (
      SELECT 'principalId' AS col, ra."principalId" AS id, ra."resourceId"
        FROM "ResourceAssignments" ra
       WHERE ra."principalId" = ANY($2::uuid[]) AND ra."deletedAt" IS NULL
      UNION ALL
      SELECT 'identityId', ra."identityId", ra."resourceId"
        FROM "ResourceAssignments" ra
       WHERE ra."identityId" = ANY($3::uuid[]) AND ra."deletedAt" IS NULL
      UNION ALL
      SELECT 'identityId', im."identityId", ra."resourceId"
        FROM "IdentityMembers" im
        JOIN "ResourceAssignments" ra ON ra."principalId" = im."principalId" AND ra."deletedAt" IS NULL
       WHERE im."identityId" = ANY($3::uuid[])
    )
    SELECT h.col, h.id, count(*)::int AS "liveEntitlements",
           count(*) FILTER (WHERE h."resourceId" IN (SELECT "resourceId" FROM linked))::int AS "linkedEntitlements"
      FROM held h
     GROUP BY h.col, h.id`;

export const LINKED_RESOURCE_COUNT_SQL = `SELECT count(*)::int AS n FROM (${LINKED_RESOURCES}) l`;

/**
 * Live entitlements of the given accounts and persons, and how many resources
 * "this application" has: { counts: Map('principalId:<id>' | 'identityId:<id>'
 * → { liveEntitlements, linkedEntitlements }), linkedResources }. Two statements.
 */
export async function entitlementCounts(db, contextId, principalIds, identityIds) {
  const [counts, linked] = await Promise.all([
    principalIds.length + identityIds.length > 0
      ? db.query(ENTITLEMENT_COUNTS_SQL, [contextId, principalIds, identityIds])
      : { rows: [] },
    db.query(LINKED_RESOURCE_COUNT_SQL, [contextId]),
  ]);
  return {
    counts: new Map(counts.rows.map(r => [`${r.col}:${r.id}`, { liveEntitlements: r.liveEntitlements, linkedEntitlements: r.linkedEntitlements }])),
    linkedResources: linked.rows[0]?.n ?? 0,
  };
}

// ─── The context's timeline (routes/recentChanges/timeline.js) ───────────
// The interviews uploaded in the window, each with how many claims the model
// proposed for it and when the last of them was made.
export const TIMELINE_INTERVIEWS_SQL = `
    SELECT iv.id, iv."intervieweeName", iv."interviewedAt"::text AS "interviewedAt", iv."fileName", iv."createdAt",
           COUNT(c.id) FILTER (WHERE c."proposedBy" = 'model')::int AS extracted,
           MAX(c."createdAt") FILTER (WHERE c."proposedBy" = 'model') AS "extractedAt"
      FROM "ContextInterviews" iv
      LEFT JOIN "ContextClaims" c ON c."interviewId" = iv.id
     WHERE iv."contextId" = $1 AND iv."createdAt" > now() - ($2::int || ' days')::interval
     GROUP BY iv.id`;

// The claims decided in the window, in the given statuses, with the role a
// confirmed role claim set (its holder by name) and the interview it came from.
export const TIMELINE_DECISIONS_SQL = `
    SELECT c.id, c."interviewId", c."claimKind", c.attribute, c.value, c."claimStatus" AS status, c."decidedAt", c."decidedBy",
           c."principalId", c."identityId", c."subjectName", COALESCE(p."displayName", i."displayName") AS "subjectDisplayName",
           iv."intervieweeName", iv."interviewedAt"::text AS "interviewedAt",
           r.role AS "appliedRole", COALESCE(rp."displayName", ri."displayName") AS "roleHolderName",
           COALESCE(r."principalId", r."identityId") AS "roleHolderId", (r."principalId" IS NOT NULL) AS "roleHolderIsAccount",
           o.overrides AS "overridesSource"
      FROM "ContextClaims" c
      JOIN "ContextInterviews" iv ON iv.id = c."interviewId"
      LEFT JOIN "Principals" p ON p.id = c."principalId"
      LEFT JOIN "Identities" i ON i.id = c."identityId"
      LEFT JOIN LATERAL (SELECT x.role, x."principalId", x."identityId" FROM "ContextRoles" x
                          WHERE x."sourceClaimId" = c.id LIMIT 1) r ON true
      LEFT JOIN "Principals" rp ON rp.id = r."principalId"
      LEFT JOIN "Identities" ri ON ri.id = r."identityId"
      LEFT JOIN "ContextMemberOverrides" o ON o."claimId" = c.id
     WHERE c."contextId" = $1 AND c."decidedAt" IS NOT NULL
       AND c."decidedAt" > now() - ($2::int || ' days')::interval
       AND c."claimStatus" = ANY($3::text[])
     ORDER BY c."decidedAt" DESC
     LIMIT $4`;

/** What the interviews add to a context's timeline: { interviews, decisions }. Two statements. */
export async function timelineRows(db, contextId, { sinceDays, statuses, limit, withInterviews }) {
  const [interviews, decisions] = await Promise.all([
    withInterviews ? db.query(TIMELINE_INTERVIEWS_SQL, [contextId, sinceDays]) : { rows: [] },
    db.query(TIMELINE_DECISIONS_SQL, [contextId, sinceDays, statuses, limit]),
  ]);
  return { interviews: interviews.rows, decisions: decisions.rows };
}
