// Identity Atlas Interviews — statements (claims), their evidence, proposals and reviews.
//
// "Someone said this" lives here; "Atlas knows this" does not. A statement is attributed
// to the interview it came from and points at the transcript spans behind it. Revising
// a statement adds the next version with its own evidence rows — the earlier version
// and its evidence are left exactly as they were (the tables refuse UPDATE).

import { randomUUID } from 'node:crypto';
import { logEvent } from './store.js';

/** The mention ids a statement refers to that do not belong to this interview. */
export async function foreignMentionIds(query, interviewId, statement) {
  const ids = [statement.subject.mentionId, statement.object.mentionId].filter(Boolean);
  if (ids.length === 0) return [];
  const { rows } = await query(
    `SELECT "id" FROM "InterviewMentions" WHERE "interviewId" = $1 AND "id" = ANY($2::uuid[])`,
    [interviewId, ids],
  );
  const found = new Set(rows.map(r => r.id));
  return ids.filter(id => !found.has(id));
}

/**
 * Inserts one statement version with its evidence.
 * @param {{ lineageId?: string, version?: number }} lineage  absent for a new claim
 * @param {(string|null)[]} excerptTexts  per evidence item, what may be stored
 */
export async function insertStatement(tx, interviewId, v, actor, excerptTexts, lineage = {}) {
  return tx(async (client) => {
    const id = randomUUID();
    const lineageId = lineage.lineageId ?? id;
    const version = lineage.version ?? 1;
    await client.query(
      `INSERT INTO "InterviewStatements" ("id", "interviewId", "lineageId", "version", "subject", "predicate", "object",
                                          "attribution", "claimConfidence", "extractor", "createdBy")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, interviewId, lineageId, version, v.subject, v.predicate, v.object, v.attribution, v.claimConfidence, v.extractor, actor],
    );
    const evidence = [];
    for (let i = 0; i < v.evidence.length; i++) {
      const e = v.evidence[i];
      const evidenceId = randomUUID();
      await client.query(
        `INSERT INTO "InterviewEvidence" ("id", "statementId", "segmentId", "startMs", "endMs", "spanStart", "spanEnd",
                                          "excerptHash", "excerptText", "sttEngine")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [evidenceId, id, e.segmentId, e.startMs, e.endMs, e.spanStart, e.spanEnd, e.excerptHash, excerptTexts[i], e.sttEngine],
      );
      evidence.push({ id: evidenceId, segmentId: e.segmentId, startMs: e.startMs, endMs: e.endMs, spanStart: e.spanStart, spanEnd: e.spanEnd, excerptHash: e.excerptHash, excerptStored: excerptTexts[i] !== null });
    }
    await logEvent((...a) => client.query(...a), interviewId, version === 1 ? 'statement-added' : 'statement-revised', actor,
      { statementId: id, lineageId, version, evidence: evidence.length });
    return { id, lineageId, version, predicate: v.predicate, subject: v.subject, object: v.object, claimConfidence: v.claimConfidence, extractor: v.extractor, evidence };
  });
}

/** A statement of this interview, with the latest version of its lineage. */
export async function loadStatement(query, interviewId, statementId) {
  const { rows } = await query(
    `SELECT s."id", s."lineageId", s."version",
            (SELECT max(x."version") FROM "InterviewStatements" x WHERE x."lineageId" = s."lineageId") AS "latestVersion"
       FROM "InterviewStatements" s WHERE s."id" = $1 AND s."interviewId" = $2`,
    [statementId, interviewId],
  );
  const row = rows[0];
  return row ? { ...row, version: Number(row.version), latestVersion: Number(row.latestVersion) } : null;
}

export async function createProposal(tx, interviewId, v, actor) {
  return tx(async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "InterviewProposals" ("id", "interviewId", "statementId", "proposalKind", "summary", "createdBy")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, interviewId, v.statementId, v.proposalKind, v.summary, actor],
    );
    await logEvent((...a) => client.query(...a), interviewId, 'proposal-added', actor, { proposalId: id, statementId: v.statementId });
    return { id, statementId: v.statementId, proposalKind: v.proposalKind, summary: v.summary, reviewState: 'proposed' };
  });
}

/** What the review gate needs: the proposal's statement version, the lineage's latest, the latest decision. */
export async function loadProposalForReview(query, interviewId, proposalId) {
  const { rows } = await query(
    `SELECT p."id", s."version" AS "proposalVersion",
            (SELECT max(x."version") FROM "InterviewStatements" x WHERE x."lineageId" = s."lineageId") AS "latestVersion",
            (SELECT d."action" FROM "InterviewReviewDecisions" d WHERE d."proposalId" = p."id" ORDER BY d."id" DESC LIMIT 1) AS "currentAction"
       FROM "InterviewProposals" p JOIN "InterviewStatements" s ON s."id" = p."statementId"
      WHERE p."id" = $1 AND p."interviewId" = $2`,
    [proposalId, interviewId],
  );
  const row = rows[0];
  return row ? { ...row, proposalVersion: Number(row.proposalVersion), latestVersion: Number(row.latestVersion), currentAction: row.currentAction ?? null } : null;
}

export async function appendReview(tx, interviewId, proposalId, review, actor, actorName) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO "InterviewReviewDecisions" ("proposalId", "action", "targetVersion", "rationale", "reviewer", "reviewerName")
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING "id", "action", "targetVersion", "rationale", "reviewer", "decidedAt"`,
      [proposalId, review.action, review.targetVersion, review.rationale, actor, actorName],
    );
    await logEvent((...a) => client.query(...a), interviewId, 'proposal-reviewed', actor, { proposalId, action: review.action, targetVersion: review.targetVersion });
    return rows[0];
  });
}

/** Everything recorded under one interview, for the post-interview review screen. */
export async function loadDetail(query, interviewId) {
  const mentions = (await query(
    `SELECT m."id", m."segmentId", m."startMs", m."endMs", m."spanStart", m."spanEnd", m."literalText", m."entityKindHint", m."detector",
            r."state", r."origin", r."entityKind", r."entityId", r."matchScore", r."decidedBy", r."decidedAt"
       FROM "InterviewMentions" m
       LEFT JOIN LATERAL (SELECT * FROM "InterviewResolutions" x WHERE x."mentionId" = m."id" ORDER BY x."id" DESC LIMIT 1) r ON TRUE
      WHERE m."interviewId" = $1 ORDER BY m."startMs", m."spanStart"`, [interviewId])).rows;
  const statements = (await query(
    `SELECT s."id", s."lineageId", s."version", s."subject", s."predicate", s."object", s."attribution", s."claimConfidence", s."extractor", s."createdAt",
            COALESCE((SELECT json_agg(json_build_object('id', e."id", 'segmentId', e."segmentId", 'startMs', e."startMs", 'endMs', e."endMs",
                       'spanStart', e."spanStart", 'spanEnd', e."spanEnd", 'excerptHash', e."excerptHash", 'excerpt', e."excerptText") ORDER BY e."startMs")
                        FROM "InterviewEvidence" e WHERE e."statementId" = s."id"), '[]'::json) AS "evidence"
       FROM "InterviewStatements" s WHERE s."interviewId" = $1 ORDER BY s."lineageId", s."version"`, [interviewId])).rows;
  const proposals = (await query(
    `SELECT p."id", p."statementId", p."proposalKind", p."summary", p."createdAt",
            (SELECT d."action" FROM "InterviewReviewDecisions" d WHERE d."proposalId" = p."id" ORDER BY d."id" DESC LIMIT 1) AS "latestAction"
       FROM "InterviewProposals" p WHERE p."interviewId" = $1 ORDER BY p."createdAt"`, [interviewId])).rows;
  return { mentions, statements, proposals };
}
