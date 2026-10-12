// Organisation knowledge extraction — a reviewer correcting a mention.
//
//   editMention(id, { label?, type? }, actor)   → { mention, candidates }
//   renamedMentions(sourceId)                    → Map<canonicalKey, { label, type }>
//
// The transcript says what it says ("FortiG", a transcription spelling); the
// reviewer says what it means ("Fortigi", an organisation). Renaming changes the
// mention's name everywhere it is used — every statement points at the one mention
// row — keeps the literal spelling as `originalLabel`, and looks for candidates
// again under the new name. The row's entityType and canonicalKey stay as the
// model produced them, so a later re-run finds the same row and keeps the
// reviewer's name and type (store.js UPSERT_MENTION) instead of adding the old one.
import { randomUUID } from 'node:crypto';
import { query, queryOne, tx } from '../../db/connection.js';
import { isUuid } from '../import/httpHelpers.js';
import { MENTION_TYPES, LIMITS } from './contracts.js';
import { resolveMentions } from './resolve.js';
import { KnowledgeReviewError } from './review.js';
import { VIA, UPSERT_LINK } from './store.js';

const MENTION_SQL = `SELECT "id", "displayName", "attributes", "sourceId" FROM "OrgEntities"
  WHERE "id" = $1 AND "origin" = 'model' AND "entityType" LIKE 'Mentioned %'`;

// Machine proposals that no longer fit the new name go; decided links stay.
const DROP_STALE_SQL = `DELETE FROM "OrgLinks"
  WHERE "orgEntityId" = $1 AND "via" = $2 AND "status" = 'proposed' AND "analystOverride" IS NULL
    AND NOT ("targetType" || ':' || "targetId"::text = ANY($3::text[]))`;

function checkEdit({ label, type }) {
  if (label === undefined && type === undefined) throw new KnowledgeReviewError(400, 'Send a new label, a new type, or both.');
  if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.trim().length > LIMITS.labelChars)) {
    throw new KnowledgeReviewError(400, `label must be text of 1 to ${LIMITS.labelChars} characters.`);
  }
  if (type !== undefined && !MENTION_TYPES.includes(type)) throw new KnowledgeReviewError(400, `type must be one of ${MENTION_TYPES.join(', ')}.`);
}

export async function editMention(id, edit = {}, actor) {
  if (!isUuid(id)) throw new KnowledgeReviewError(400, 'The mention id must be a UUID.');
  checkEdit(edit);
  const row = await queryOne(MENTION_SQL, [id]);
  if (!row) throw new KnowledgeReviewError(404, 'Mention not found.');
  const label = edit.label !== undefined ? edit.label.trim() : row.displayName;
  const type = edit.type ?? row.attributes?.mentionType;
  const at = new Date().toISOString();
  const attrs = { ...row.attributes, label };
  if (edit.label !== undefined && label !== row.displayName) {
    attrs.originalLabel = row.attributes?.originalLabel ?? row.displayName;
    Object.assign(attrs, { renamedBy: actor, renamedAt: at });
  }
  if (edit.type !== undefined && edit.type !== row.attributes?.mentionType) Object.assign(attrs, { mentionType: type, typeChangedBy: actor });

  const resolution = (await resolveMentions([{ key: 'edit', type, label }])).get('edit') ?? { status: 'unmatched', candidates: [] };
  attrs.resolution = resolution.status;
  await tx(async (client) => {
    await client.query(`UPDATE "OrgEntities" SET "displayName" = $2, "attributes" = $3 WHERE "id" = $1`, [id, label, JSON.stringify(attrs)]);
    await client.query(DROP_STALE_SQL, [id, VIA, resolution.candidates.map(c => `${c.targetType}:${c.targetId}`)]);
    for (const c of resolution.candidates) {
      await client.query(UPSERT_LINK, [randomUUID(), id, c.targetType, c.targetId, c.confidence, c.signals.join(','),
        c.matchedField, c.matchedValue, null, VIA, label]);
    }
  });
  return { mention: { id, label, type, originalLabel: attrs.originalLabel ?? null, resolution: resolution.status }, candidates: resolution.candidates };
}

/** The reviewer's names and types for this transcript's mentions, keyed as the pipeline keys them. */
export async function renamedMentions(sourceId) {
  const r = await query(`SELECT "canonicalKey", "displayName", "attributes" FROM "OrgEntities"
    WHERE "sourceId" = $1 AND "origin" = 'model' AND ("attributes" ? 'renamedBy' OR "attributes" ? 'typeChangedBy')`, [sourceId]);
  return new Map(r.rows.map(row => [row.canonicalKey, { label: row.displayName, type: row.attributes?.mentionType }]));
}
