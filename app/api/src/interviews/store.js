// Identity Atlas Interviews — the interview record: sessions, mentions, resolutions,
// the audit trail and deletion. Claims (statements, evidence, proposals, reviews) are
// in claims.js.
//
// Every write here goes to an Interview* table. Nothing in this module — or in claims.js —
// writes to a canonical table; canonicalWrites.guard.test.js scans every interview file for that.

import { randomUUID } from 'node:crypto';
import { ENTITIES } from '../nlreports/catalog.js';

/**
 * Who owns what the caller creates. Signed in: their Entra object id. Auth off: one
 * shared 'anonymous' owner (an install without sign-in has no users to tell apart).
 * Signed in WITHOUT an object id: null, and the caller is refused.
 */
export function ownerKeyOf(req) {
  if (!req.user) return 'anonymous';
  return typeof req.user.oid === 'string' && req.user.oid ? `oid:${req.user.oid}` : null;
}

export const actorNameOf = (req) =>
  (req.user && (req.user.preferred_username || req.user.upn || req.user.name)) || null;

/** Appends one audit event. `detail` must never carry spoken content. */
export async function logEvent(q, interviewId, action, actor, detail = null) {
  await q(
    `INSERT INTO "InterviewEvents" ("interviewId", "action", "actor", "detail") VALUES ($1, $2, $3, $4)`,
    [interviewId, action, actor, detail],
  );
}

export async function createInterview(tx, v, owner, ownerName) {
  return tx(async (client) => {
    const id = randomUUID();
    const { rows } = await client.query(
      `INSERT INTO "Interviews" ("id", "interviewType", "title", "ownerKey", "ownerName", "subjectIdentityId", "scopeContextId",
                                 "storagePolicy", "noticeVersion", "noticeConfirmedAt", "retainUntil")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now() + make_interval(days => $10))
       RETURNING *`,
      [id, v.interviewType, v.title, owner, ownerName, v.subjectIdentityId, v.scopeContextId, v.storagePolicy, v.noticeVersion, v.retentionDays],
    );
    await logEvent((...a) => client.query(...a), id, 'created', owner,
      { interviewType: v.interviewType, storagePolicy: v.storagePolicy, retentionDays: v.retentionDays, noticeVersion: v.noticeVersion });
    return rows[0];
  });
}

export async function listInterviews(query, owner) {
  const { rows } = await query(
    `SELECT "id", "interviewType", "title", "storagePolicy", "subjectIdentityId", "scopeContextId", "createdAt", "retainUntil"
       FROM "Interviews" WHERE "ownerKey" = $1 AND "retainUntil" > now()
      ORDER BY "createdAt" DESC LIMIT 200`,
    [owner],
  );
  return rows;
}

export async function loadInterview(query, id) {
  const { rows } = await query(`SELECT *, ("retainUntil" <= now()) AS "expired" FROM "Interviews" WHERE "id" = $1`, [id]);
  return rows[0] || null;
}

export async function insertMentions(tx, interviewId, mentions, actor) {
  return tx(async (client) => {
    const out = [];
    for (const m of mentions) {
      const { rows } = await client.query(
        `INSERT INTO "InterviewMentions" ("id", "interviewId", "segmentId", "startMs", "endMs", "spanStart", "spanEnd",
                                          "literalText", "entityKindHint", "detector", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING "id", "segmentId", "startMs", "endMs", "spanStart", "spanEnd", "literalText", "entityKindHint", "detector"`,
        [randomUUID(), interviewId, m.segmentId, m.startMs, m.endMs, m.spanStart, m.spanEnd, m.literalText, m.entityKindHint, m.detector, actor],
      );
      out.push({ ...rows[0], resolution: null });
    }
    await logEvent((...a) => client.query(...a), interviewId, 'mentions-added', actor, { count: mentions.length });
    return out;
  });
}

/** The mention (scoped to its interview) and its latest resolution state. */
export async function loadMention(query, interviewId, mentionId) {
  const { rows } = await query(
    `SELECT m."id", (SELECT r."state" FROM "InterviewResolutions" r WHERE r."mentionId" = m."id" ORDER BY r."id" DESC LIMIT 1) AS "state"
       FROM "InterviewMentions" m WHERE m."id" = $1 AND m."interviewId" = $2`,
    [mentionId, interviewId],
  );
  return rows[0] || null;
}

/** Does a live entity of this kind exist? Uses the report catalog's not-deleted filter. */
export async function entityExists(query, kind, id) {
  const entity = ENTITIES[kind];
  const { rows } = await query(`SELECT 1 FROM "${entity.table}" n0 WHERE n0."id" = $1 AND ${entity.where('n0')}`, [id]);
  return rows.length > 0;
}

export async function appendResolution(tx, interviewId, mentionId, r, actor) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO "InterviewResolutions" ("mentionId", "state", "origin", "entityKind", "entityId", "matchScore", "candidateCount", "rationale", "decidedBy")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING "id", "state", "origin", "entityKind", "entityId", "matchScore", "candidateCount", "rationale", "decidedBy", "decidedAt"`,
      [mentionId, r.state, r.origin, r.entityKind, r.entityId, r.matchScore, r.candidateCount, r.rationale, actor],
    );
    await logEvent((...a) => client.query(...a), interviewId, 'mention-resolved', actor, { mentionId, state: r.state, origin: r.origin });
    return rows[0];
  });
}

/**
 * Deletes the interview and everything recorded under it (cascade). The audit trail
 * keeps one 'deleted' event with counts only — enough to show that and when it was
 * deleted, nothing of what was said.
 */
export async function deleteInterview(tx, interviewId, actor) {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT (SELECT count(*) FROM "InterviewMentions" WHERE "interviewId" = $1) AS "mentions",
              (SELECT count(*) FROM "InterviewStatements" WHERE "interviewId" = $1) AS "statements",
              (SELECT count(*) FROM "InterviewProposals" WHERE "interviewId" = $1) AS "proposals"`,
      [interviewId],
    );
    const counts = Object.fromEntries(Object.entries(rows[0] || {}).map(([k, v]) => [k, Number(v)]));
    await client.query(`DELETE FROM "Interviews" WHERE "id" = $1`, [interviewId]);
    await logEvent((...a) => client.query(...a), interviewId, 'deleted', actor, counts);
    return counts;
  });
}
