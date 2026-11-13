// Organizational knowledge — an analyst states a link by hand (the workbench's
// "Add" on a person), and the query over links.
//
//   parseLink(body)                              → { kind, value, holder, quote, status } or throws KnowledgeError
//   addKnowledgeLink(db, contextId, body, user)  → the claim row (as the claims API lists it)
//   peopleWithObject(db, objectId)               → who is said to hold one object, with the state of each claim
//
// A hand-made link is a claim like any other: proposedBy 'analyst', its source
// the unit's "Analyst notes" (one per unit, created on first use, no text),
// confirmed at once by the analyst who adds it (or left proposed when asked).
// Confirmed, it names its object (objects.js). Knowledge only — never access.

import { isKnowledgeKind, KNOWLEDGE_KINDS, MAX_OBJECT_NAME } from '../../lib/orgKnowledge.js';
import { objectFor } from './objects.js';
import * as store from '../interviews/store.js';

export class KnowledgeError extends Error {
  constructor(status, message) { super(message); this.name = 'KnowledgeError'; this.status = status; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ANALYST_NOTES = 'Analyst notes';
const MAX_QUOTE = 1000;

function holderOf(body) {
  const given = ['identityId', 'principalId'].filter(k => body[k]);
  if (given.length !== 1) throw new KnowledgeError(400, 'Say who it is about: one of identityId or principalId');
  const id = String(body[given[0]]).toLowerCase();
  if (!UUID_RE.test(id)) throw new KnowledgeError(400, `${given[0]} must be a uuid`);
  return { col: given[0], id };
}

/** The body of POST /contexts/:id/knowledge, checked. Pure. */
export function parseLink(body = {}) {
  if (!isKnowledgeKind(body.kind)) throw new KnowledgeError(400, `kind must be one of ${KNOWLEDGE_KINDS.join(', ')}`);
  const value = typeof body.value === 'string' ? body.value.replace(/\s+/g, ' ').trim() : '';
  if (!value) throw new KnowledgeError(400, 'value must name the activity, expertise or duty');
  if (value.length > MAX_OBJECT_NAME) throw new KnowledgeError(400, `value is a name of at most ${MAX_OBJECT_NAME} characters`);
  const status = body.status ?? 'confirmed';
  if (!['confirmed', 'proposed'].includes(status)) throw new KnowledgeError(400, 'status must be confirmed or proposed');
  const quote = typeof body.quote === 'string' && body.quote.trim() ? body.quote.trim().slice(0, MAX_QUOTE) : null;
  return { kind: body.kind, value, holder: holderOf(body), quote, status };
}

export const NOTES_SOURCE_SQL = `
  SELECT id FROM "ContextInterviews"
   WHERE "contextId" = $1 AND "fileName" = $2 AND "principalId" IS NULL AND "identityId" IS NULL
   ORDER BY "createdAt" LIMIT 1`;

export const INSERT_NOTES_SQL = `
  INSERT INTO "ContextInterviews" ("contextId", "intervieweeName", "interviewedAt", "fileName", transcript, "extractionStatus", "createdBy")
  VALUES ($1, $2, CURRENT_DATE, $3, '', 'done', $4)
  RETURNING id`;

export const INSERT_LINK_SQL = `
  INSERT INTO "ContextClaims"
    ("interviewId", "contextId", "claimKind", "subjectKind", "principalId", "identityId", "subjectName", "subjectMatch",
     value, quote, confidence, relevance, "claimStatus", "proposedBy", "decidedBy", "decidedAt", "objectContextId")
  VALUES ($1, $2, $3, 'Person', $4, $5, $6, 'key', $7, $8, 1, 'high', $9, 'analyst', $10,
          CASE WHEN $9 = 'proposed' THEN NULL ELSE now() END, $11)
  RETURNING id`;

async function notesSource(client, contextId, user) {
  const found = (await client.query(NOTES_SOURCE_SQL, [contextId, ANALYST_NOTES])).rows[0];
  if (found) return found.id;
  return (await client.query(INSERT_NOTES_SQL, [contextId, user || 'Analyst', ANALYST_NOTES, user ?? null])).rows[0].id;
}

/** Add a link stated by an analyst, on the unit it was stated for. */
export async function addKnowledgeLink(db, contextId, body, user) {
  if (!UUID_RE.test(String(contextId))) throw new KnowledgeError(400, 'Invalid ID format');
  const link = parseLink(body);
  const id = await db.tx(async (client) => {
    const ctx = (await client.query(`SELECT id FROM "Contexts" WHERE id = $1`, [contextId])).rows[0];
    if (!ctx) throw new KnowledgeError(404, 'Context not found');
    const table = link.holder.col === 'identityId' ? 'Identities' : 'Principals';
    const person = (await client.query(`SELECT "displayName" FROM "${table}" WHERE id = $1`, [link.holder.id])).rows[0];
    if (!person) throw new KnowledgeError(404, link.holder.col === 'identityId' ? 'Identity not found' : 'Principal not found');
    const interviewId = await notesSource(client, contextId, user);
    const object = link.status === 'proposed' ? null : await objectFor(client, link.kind, link.value);
    const r = await client.query(INSERT_LINK_SQL, [
      interviewId, contextId, link.kind,
      link.holder.col === 'principalId' ? link.holder.id : null, link.holder.col === 'identityId' ? link.holder.id : null,
      person.displayName, link.value, link.quote, link.status, link.status === 'proposed' ? null : (user ?? null), object?.id ?? null,
    ]);
    return r.rows[0].id;
  });
  return store.getClaimRow(db, id);
}

export const PEOPLE_WITH_OBJECT_SQL = `
  SELECT COALESCE(c."identityId", im."identityId") AS "identityId", c."principalId",
         COALESCE(i."displayName", p."displayName", c."subjectName") AS "displayName",
         c."claimStatus" AS status, c."contextId", ctx."displayName" AS "contextName", c.id AS "claimId"
    FROM "ContextClaims" c
    JOIN "Contexts" ctx ON ctx.id = c."contextId"
    LEFT JOIN "IdentityMembers" im ON im."principalId" = c."principalId"
    LEFT JOIN "Identities" i ON i.id = COALESCE(c."identityId", im."identityId")
    LEFT JOIN "Principals" p ON p.id = c."principalId"
   WHERE c."objectContextId" = $1
   ORDER BY 3, c."createdAt"`;

/** Who is said to hold an object (an Activity / Expertise / Duty context), claim by claim. */
export async function peopleWithObject(db, objectId) {
  if (!UUID_RE.test(String(objectId))) throw new KnowledgeError(400, 'Invalid ID format');
  return (await db.query(PEOPLE_WITH_OBJECT_SQL, [objectId])).rows;
}
