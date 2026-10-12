// Organisation knowledge extraction — the reviewer's decisions, kept apart:
//
//   reviewMatch(linkId, { action, targetType?, targetId? }, actor)   which object a MENTION is
//       confirm  this candidate is the one (other open candidates of the same target type → rejected)
//       reject   not this one (kept, never proposed again on a re-run: analystOverride is set)
//       choose   none of the candidates: link to another object the reviewer found
//       reset    undo the decision (back to proposed)
//   reviewClaim(relationId, { status, expectedStatus?, predicate?, qualifier? }, actor)
//       whether the STATEMENT holds — independent of the match: "Rob is in the Omada team"
//       can be accepted while it is still open which Rob.
//   reviewFinding(findingId, { status }, actor)
//
// Unlike an organisation list (linking/review.js), confirming a mention never applies
// the same decision to other mentions with the same text: "Rob" in the next interview
// may be another Rob. Every change is in _history (the triggers on these tables).
import { randomUUID } from 'node:crypto';
import { query, queryOne, tx } from '../../db/connection.js';
import { isUuid } from '../import/httpHelpers.js';
import { TARGET_TABLES } from '../linking/candidates.js';
import { PREDICATES, FINDING_STATUSES, LIMITS } from './contracts.js';
import { VIA } from './store.js';

export class KnowledgeReviewError extends Error {
  constructor(httpStatus, message) { super(message); this.httpStatus = httpStatus; }
}

export const MATCH_ACTIONS = Object.freeze(['confirm', 'reject', 'choose', 'reset']);
export const CLAIM_REVIEW_STATUSES = Object.freeze(['proposed', 'accepted', 'rejected']);

const STAMP = `"overriddenBy" = $2, "overriddenAt" = now() AT TIME ZONE 'utc', "updatedAt" = now() AT TIME ZONE 'utc'`;
const SET_SQL = `UPDATE "OrgLinks" SET "status" = $3, "analystOverride" = $4, ${STAMP} WHERE "id" = $1 RETURNING *`;
const RESET_SQL = `UPDATE "OrgLinks" SET "status" = 'proposed', "analystOverride" = NULL, "overriddenBy" = NULL, "overriddenAt" = NULL,
  "updatedAt" = now() AT TIME ZONE 'utc' WHERE "id" = $1 RETURNING *`;
const REJECT_OTHERS_SQL = `UPDATE "OrgLinks" SET "status" = 'rejected', "updatedAt" = now() AT TIME ZONE 'utc'
  WHERE "orgEntityId" = $1 AND "id" <> $2 AND "status" = 'proposed' AND "analystOverride" IS NULL AND "targetType" = $3`;
const CHOOSE_SQL = `INSERT INTO "OrgLinks"
    ("id", "orgEntityId", "targetType", "targetId", "confidence", "signals", "via", "orgValue", "origin", "status",
     "analystOverride", "overriddenBy", "overriddenAt")
  VALUES ($1, $3, $4, $5, 100, 'analyst', $6, $7, 'analyst', 'accepted', 'moved', $2, now() AT TIME ZONE 'utc')
  ON CONFLICT ("orgEntityId", "targetType", "targetId", (COALESCE("via", ''))) DO UPDATE SET
    "status" = 'accepted', "analystOverride" = 'moved', ${STAMP}
  RETURNING *`;
const REJECT_OPEN_SQL = `UPDATE "OrgLinks" SET "status" = 'rejected', "updatedAt" = now() AT TIME ZONE 'utc'
  WHERE "orgEntityId" = $1 AND "id" <> $2 AND "status" = 'proposed' AND "analystOverride" IS NULL`;

async function loadMentionLink(id) {
  if (!isUuid(id)) throw new KnowledgeReviewError(400, 'The link id must be a UUID.');
  const link = await queryOne(`SELECT * FROM "OrgLinks" WHERE "id" = $1 AND "via" = $2`, [id, VIA]);
  if (!link) throw new KnowledgeReviewError(404, 'Match candidate not found.');
  return link;
}

export async function reviewMatch(linkId, { action, targetType, targetId } = {}, actor) {
  if (!MATCH_ACTIONS.includes(action)) throw new KnowledgeReviewError(400, `action must be one of ${MATCH_ACTIONS.join(', ')}.`);
  const link = await loadMentionLink(linkId);
  if (action === 'reset') return { link: await queryOne(RESET_SQL, [link.id]) };
  if (action === 'reject') return { link: await queryOne(SET_SQL, [link.id, actor, 'rejected', 'rejected']) };
  if (action === 'confirm') {
    return tx(async (client) => {
      const confirmed = (await client.query(SET_SQL, [link.id, actor, 'accepted', 'confirmed'])).rows[0];
      await client.query(REJECT_OTHERS_SQL, [link.orgEntityId, link.id, link.targetType]);
      return { link: confirmed };
    });
  }
  // choose: another object entirely
  if (!TARGET_TABLES[targetType]) throw new KnowledgeReviewError(400, `targetType must be one of ${Object.keys(TARGET_TABLES).join(', ')}.`);
  if (!isUuid(targetId)) throw new KnowledgeReviewError(400, 'Choosing another object needs its targetId (a UUID).');
  const exists = await queryOne(`SELECT "id" FROM "${TARGET_TABLES[targetType].table}" WHERE "id" = $1`, [targetId]);
  if (!exists) throw new KnowledgeReviewError(400, `targetId is not a known ${targetType}.`);
  return tx(async (client) => {
    const chosen = (await client.query(CHOOSE_SQL, [randomUUID(), actor, link.orgEntityId, targetType, targetId, VIA, link.orgValue ?? null])).rows[0];
    await client.query(REJECT_OPEN_SQL, [link.orgEntityId, chosen.id]);
    return { link: chosen };
  });
}

/**
 * A mention with NO candidate (an unknown name, a misheard one) linked by hand to
 * an object the reviewer found: the same 'moved' analyst link `choose` writes.
 */
export async function chooseForMention(mentionId, { targetType, targetId } = {}, actor) {
  if (!isUuid(mentionId)) throw new KnowledgeReviewError(400, 'The mention id must be a UUID.');
  const mention = await queryOne(`SELECT "id", "displayName" FROM "OrgEntities" WHERE "id" = $1 AND "origin" = 'model' AND "entityType" LIKE 'Mentioned %'`, [mentionId]);
  if (!mention) throw new KnowledgeReviewError(404, 'Mention not found.');
  if (!TARGET_TABLES[targetType]) throw new KnowledgeReviewError(400, `targetType must be one of ${Object.keys(TARGET_TABLES).join(', ')}.`);
  if (!isUuid(targetId)) throw new KnowledgeReviewError(400, 'Choosing an object needs its targetId (a UUID).');
  const exists = await queryOne(`SELECT "id" FROM "${TARGET_TABLES[targetType].table}" WHERE "id" = $1`, [targetId]);
  if (!exists) throw new KnowledgeReviewError(400, `targetId is not a known ${targetType}.`);
  return tx(async (client) => {
    const chosen = (await client.query(CHOOSE_SQL, [randomUUID(), actor, mention.id, targetType, targetId, VIA, mention.displayName])).rows[0];
    await client.query(REJECT_OPEN_SQL, [mention.id, chosen.id]);
    return { link: chosen };
  });
}

const BULK_SQL = `
  UPDATE "OrgRelations"
     SET "status" = $2,
         "attributes" = ("attributes" - 'rejectedBy') || jsonb_build_object('reviewedBy', $3::text, 'reviewedAt', $4::text, 'bulk', true)
   WHERE "sourceId" = $1 AND "attributes" ? 'claimKey' AND "status" = 'proposed'
     AND ($5::uuid[] IS NULL OR "id" = ANY($5::uuid[]))
  RETURNING "id"`;

/**
 * "Accept (or reject) all the rest": every statement of this transcript that is
 * STILL proposed — limited to `ids` (what the reviewer was looking at) when given.
 * A statement someone already decided is never flipped.
 */
export async function bulkReviewClaims(sourceId, { status, ids } = {}, actor) {
  if (!isUuid(sourceId)) throw new KnowledgeReviewError(400, 'The transcript id must be a UUID.');
  if (!['accepted', 'rejected'].includes(status)) throw new KnowledgeReviewError(400, 'status must be accepted or rejected.');
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1000 || !ids.every(isUuid))) {
    throw new KnowledgeReviewError(400, 'ids must be a list of at most 1000 statement ids.');
  }
  const rows = (await query(BULK_SQL, [sourceId, status, actor, new Date().toISOString(), ids ?? null])).rows;
  return { status, updated: rows.length, ids: rows.map(r => r.id) };
}

const CLAIM_SQL = `SELECT "id", "status", "predicate", "attributes" FROM "OrgRelations" WHERE "id" = $1 AND "attributes" ? 'claimKey'`;

function checkClaimInput(id, { status, predicate, qualifier }) {
  if (!isUuid(id)) throw new KnowledgeReviewError(400, 'The statement id must be a UUID.');
  if (!CLAIM_REVIEW_STATUSES.includes(status)) throw new KnowledgeReviewError(400, `status must be one of ${CLAIM_REVIEW_STATUSES.join(', ')}.`);
  if (predicate !== undefined && !PREDICATES.includes(predicate)) throw new KnowledgeReviewError(400, `predicate must be one of ${PREDICATES.join(', ')}.`);
  if (qualifier !== undefined && qualifier !== null && (typeof qualifier !== 'string' || qualifier.length > LIMITS.qualifierChars)) {
    throw new KnowledgeReviewError(400, `qualifier must be text of at most ${LIMITS.qualifierChars} characters.`);
  }
}

// The statement's new attributes: who reviewed it, and — for an edit — what it was before.
export function reviewedAttributes(row, { status, predicate, qualifier }, actor, at = new Date().toISOString()) {
  const before = row.attributes?.qualifier ?? null;
  const attrs = { ...row.attributes, reviewedBy: actor, reviewedAt: at };
  const edits = {};
  if (predicate !== undefined && predicate !== row.predicate) edits.predicate = row.predicate;
  if (qualifier !== undefined && (qualifier || null) !== before) edits.qualifier = before;
  if (Object.keys(edits).length) attrs.edited = { by: actor, at, from: edits };
  if (qualifier !== undefined) attrs.qualifier = qualifier || null;
  if (status !== 'rejected') delete attrs.rejectedBy;
  return attrs;
}

export async function reviewClaim(id, input = {}, actor) {
  checkClaimInput(id, input);
  const { status, expectedStatus, predicate } = input;
  return tx(async (client) => {
    const row = (await client.query(`${CLAIM_SQL} FOR UPDATE`, [id])).rows[0];
    if (!row) throw new KnowledgeReviewError(404, 'Statement not found.');
    // Two reviewers on one statement: the second sees what the first decided.
    if (expectedStatus && row.status !== expectedStatus) {
      throw new KnowledgeReviewError(409, `The statement was already set to "${row.status}" by someone else; reload to see it.`);
    }
    const attrs = reviewedAttributes(row, input, actor);
    const updated = (await client.query(
      `UPDATE "OrgRelations" SET "status" = $2, "predicate" = $3, "attributes" = $4 WHERE "id" = $1 RETURNING "id", "status", "predicate", "attributes"`,
      [id, status, predicate ?? row.predicate, JSON.stringify(attrs)])).rows[0];
    return { id: updated.id, status: updated.status, predicate: updated.predicate, qualifier: updated.attributes?.qualifier ?? null, edited: updated.attributes?.edited ?? null };
  });
}

export async function reviewFinding(id, { status } = {}, actor) {
  if (!isUuid(id)) throw new KnowledgeReviewError(400, 'The finding id must be a UUID.');
  if (!FINDING_STATUSES.includes(status)) throw new KnowledgeReviewError(400, `status must be one of ${FINDING_STATUSES.join(', ')}.`);
  const row = await queryOne(`UPDATE "OrgKnowledgeFindings" SET "status" = $2, "decidedBy" = $3, "decidedAt" = now() AT TIME ZONE 'utc'
    WHERE "id" = $1 RETURNING "id", "status", "decidedBy", "decidedAt"`, [id, status, status === 'open' ? null : actor]);
  if (!row) throw new KnowledgeReviewError(404, 'Finding not found.');
  return row;
}
