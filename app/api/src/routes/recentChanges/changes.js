// Recent-changes endpoints — GET /api/{user,resources,access-package,identities}/:id/recent-changes.
//
// Per-entity "what recently moved" panels built from the _history audit table.
// Each handler pulls candidate rows, then hands them to a row classifier in
// ./classify.js via the shared collectHistoryEvents loop. Extracted from
// routes/recentChanges.js (audit finding C1) and further decomposed for
// complexity (#1031) — the public paths are unchanged and no behaviour differs.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE, clampDays, clampLimit } from './shared.js';
import {
  collectHistoryEvents, classifyUserRow, classifyResourceRow,
  classifyAccessPackageRow, classifyIdentityRow,
} from './classify.js';

const router = Router();

const EMPTY = { sinceDays: 0, events: [], addedCount: 0, removedCount: 0 };

// ─── /api/user/:id/recent-changes ────────────────────────────────────
router.get('/user/:id/recent-changes', async (req, res) => {
  if (!useSql) return res.json(EMPTY);
  const userId = req.params.id;
  if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const sinceDays = clampDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    // Pull every candidate _history row in one query so we can sort by
    // changedAt cheaply; we enrich + classify in JS (see classify.js).
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND (
           ("tableName" = 'ResourceAssignments' AND "rowData"->>'principalId' = $2)
           OR ("tableName" = 'IdentityMembers'   AND "rowData"->>'principalId' = $2)
           OR ("tableName" = 'Principals'        AND "rowId" = $2 AND operation = 'U')
         )
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, userId, limit * 2]);

    const { events, addedCount, removedCount } = await collectHistoryEvents(r.rows, limit, classifyUserRow);
    res.json({ sinceDays, addedCount, removedCount, events });
  } catch (err) {
    console.error('user recent-changes failed:', err.message);
    res.status(500).json({ error: 'Failed to load recent changes' });
  }
});

// ─── /api/resources/:id/recent-changes ───────────────────────────────
router.get('/resources/:id/recent-changes', async (req, res) => {
  if (!useSql) return res.json(EMPTY);
  const resId = req.params.id;
  if (!UUID_RE.test(resId)) return res.status(400).json({ error: 'Invalid resource id' });

  const sinceDays = clampDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND (
           ("tableName" = 'ResourceAssignments'
              AND "rowData"->>'resourceId' = $2)
           OR ("tableName" = 'ResourceRelationships'
              AND ("rowData"->>'childResourceId' = $2 OR "rowData"->>'parentResourceId' = $2))
         )
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, resId, limit * 2]);

    const { events, addedCount, removedCount } =
      await collectHistoryEvents(r.rows, limit, (row) => classifyResourceRow(row, resId));
    res.json({ sinceDays, addedCount, removedCount, events });
  } catch (err) {
    console.error('resource recent-changes failed:', err.message);
    res.status(500).json({ error: 'Failed to load recent changes' });
  }
});

// ─── /api/access-package/:id/recent-changes ──────────────────────────
// Same underlying data as /api/resources/:id/recent-changes but filtered
// to governance events so a BR's timeline doesn't drown in app-role grants.
router.get('/access-package/:id/recent-changes', async (req, res) => {
  if (!useSql) return res.json(EMPTY);
  const apId = req.params.id;
  if (!UUID_RE.test(apId)) return res.status(400).json({ error: 'Invalid access package id' });

  const sinceDays = clampDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND (
           ("tableName" = 'ResourceAssignments'
              AND "rowData"->>'resourceId' = $2)
           OR ("tableName" = 'ResourceRelationships'
              AND "rowData"->>'parentResourceId' = $2
              AND COALESCE("rowData"->>'relationshipType','') = 'Contains')
         )
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, apId, limit * 2]);

    const { events, addedCount, removedCount } =
      await collectHistoryEvents(r.rows, limit, classifyAccessPackageRow);
    res.json({ sinceDays, addedCount, removedCount, events });
  } catch (err) {
    console.error('access-package recent-changes failed:', err.message);
    res.status(500).json({ error: 'Failed to load recent changes' });
  }
});

// ─── /api/identities/:id/recent-changes ──────────────────────────────
router.get('/identities/:id/recent-changes', async (req, res) => {
  if (!useSql) return res.json(EMPTY);
  const idenId = req.params.id;
  if (!UUID_RE.test(idenId)) return res.status(400).json({ error: 'Invalid identity id' });

  const sinceDays = clampDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND "tableName" = 'IdentityMembers'
         AND "rowData"->>'identityId' = $2
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, idenId, limit * 2]);

    const { events, addedCount, removedCount } =
      await collectHistoryEvents(r.rows, limit, classifyIdentityRow);
    res.json({ sinceDays, addedCount, removedCount, events });
  } catch (err) {
    console.error('identity recent-changes failed:', err.message);
    res.status(500).json({ error: 'Failed to load recent changes' });
  }
});

export default router;
