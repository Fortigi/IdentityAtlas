// Context-to-context relationships — GET /api/contexts/:id/relationships,
// POST /contexts/:id/relationships and DELETE /contexts/:id/relationships/:relId.
//
// One type so far: SameUnitAs — two contexts are one unit seen through a
// different kind of member: "Contoso" as its people, its accounts and its
// resources is three contexts, linked pairwise. A context still holds one kind
// of member; the link is what lets the UI show the three as one unit.
//
// Symmetric: a pair is stored once (a unique index on the unordered pair), the
// GET lists it from either end, and either end may delete it. "direction" in
// the GET only says which way round it happens to be stored.
// Design: docs/architecture/context-templates-phase-b.md.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { CONTEXT_RELATIONSHIP_TYPES } from '../../ingest/validation.js';
import { useSql, UUID_RE, writeContexts } from './shared.js';

const router = Router();

// Body of POST: { relatedContextId, relationshipType }. Returns { status,
// message } on the first failure, else { relatedContextId, relationshipType }.
export function parseRelationshipBody(body, contextId) {
  if (!CONTEXT_RELATIONSHIP_TYPES.includes(body.relationshipType)) {
    return { status: 400, message: `relationshipType must be one of ${CONTEXT_RELATIONSHIP_TYPES.join(', ')}` };
  }
  if (!UUID_RE.test(String(body.relatedContextId ?? ''))) return { status: 400, message: 'relatedContextId (uuid) is required' };
  const relatedContextId = String(body.relatedContextId).toLowerCase();
  if (relatedContextId === contextId.toLowerCase()) return { status: 400, message: 'A context cannot relate to itself' };
  return { relatedContextId, relationshipType: body.relationshipType };
}

// ─── GET /api/contexts/:id/relationships ─────────────────────────────
router.get('/contexts/:id/relationships', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const ctx = await db.queryOne(`SELECT id FROM "Contexts" WHERE id = $1`, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });
    const r = await db.query(`
      SELECT r.id, r."relationshipType", r."addedBy", r."createdAt",
             CASE WHEN r."contextId" = $1 THEN 'out' ELSE 'in' END AS direction,
             o.id AS "relatedContextId", o."displayName" AS "relatedDisplayName",
             o."contextCategory" AS "relatedContextCategory", o."targetType" AS "relatedTargetType",
             o."totalMemberCount" AS "relatedTotalMemberCount"
        FROM "ContextRelationships" r
        JOIN "Contexts" o
          ON o.id = CASE WHEN r."contextId" = $1 THEN r."relatedContextId" ELSE r."contextId" END
       WHERE r."contextId" = $1 OR r."relatedContextId" = $1
       ORDER BY direction DESC, o."displayName"
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /contexts/:id/relationships failed:', err.message);
    res.status(500).json({ error: 'Failed to load context relationships' });
  }
});

// ─── POST /api/contexts/:id/relationships ────────────────────────────
// Body: { relatedContextId, relationshipType }. 404 when either context is
// missing; 400 on a self-link, when the pair already has this relationship in
// either direction, or when both hold the same kind of member (two people
// contexts are two units, or one duplicated, never variants of one).
router.post('/contexts/:id/relationships', writeContexts, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const parsed = parseRelationshipBody(req.body || {}, req.params.id);
  if (parsed.status) return res.status(parsed.status).json({ error: parsed.message });
  const { relatedContextId, relationshipType } = parsed;

  try {
    const found = await db.query(`SELECT id, "targetType" FROM "Contexts" WHERE id = ANY($1::uuid[])`, [[req.params.id, relatedContextId]]);
    if (found.rows.length !== 2) return res.status(404).json({ error: 'Context not found' });
    if (found.rows[0].targetType === found.rows[1].targetType) {
      return res.status(400).json({ error: 'Variants of one unit hold different kinds of member; these two both hold ' + found.rows[0].targetType });
    }

    const dup = await db.queryOne(`
      SELECT id FROM "ContextRelationships"
       WHERE "relationshipType" = $3
         AND (("contextId" = $1 AND "relatedContextId" = $2) OR ("contextId" = $2 AND "relatedContextId" = $1))
    `, [req.params.id, relatedContextId, relationshipType]);
    if (dup) return res.status(400).json({ error: 'These two contexts already have this relationship' });

    const ins = await db.query(`
      INSERT INTO "ContextRelationships" ("contextId", "relatedContextId", "relationshipType", "addedBy")
      VALUES ($1, $2, $3, 'analyst')
      RETURNING id, "contextId", "relatedContextId", "relationshipType", "addedBy", "createdAt"
    `, [req.params.id, relatedContextId, relationshipType]);
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error('POST /contexts/:id/relationships failed:', err.message);
    res.status(500).json({ error: 'Failed to add context relationship' });
  }
});

// ─── DELETE /api/contexts/:id/relationships/:relId ───────────────────
// Either end of the relationship may remove it.
router.delete('/contexts/:id/relationships/:relId', writeContexts, async (req, res) => {
  const { id, relId } = req.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(relId)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.query(`
      DELETE FROM "ContextRelationships"
       WHERE id = $1 AND ("contextId" = $2 OR "relatedContextId" = $2)
    `, [relId, id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Relationship not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /contexts/:id/relationships/:relId failed:', err.message);
    res.status(500).json({ error: 'Failed to remove context relationship' });
  }
});

export default router;
