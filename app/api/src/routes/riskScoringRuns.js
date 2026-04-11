// Identity Atlas v5 — Risk scoring run endpoints.
//
// POST /risk-scoring/runs        — start a new run, returns 202 + the run row.
//                                  The actual scoring runs in the background;
//                                  the wizard polls /:id for progress.
// GET  /risk-scoring/runs        — list recent runs (newest first)
// GET  /risk-scoring/runs/:id    — single-run status (used by the polling UI)

import { Router } from 'express';
import * as db from '../db/connection.js';
import { runScoring } from '../riskscoring/engine.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

router.post('/risk-scoring/runs', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { classifierId } = req.body || {};
  try {
    // Verify the classifier exists if one is supplied
    let resolvedClsId = classifierId;
    if (resolvedClsId) {
      const r = await db.queryOne(`SELECT id FROM "RiskClassifiers" WHERE id = $1`, [resolvedClsId]);
      if (!r) return res.status(404).json({ error: 'Classifier not found' });
    } else {
      const active = await db.queryOne(`SELECT id FROM "RiskClassifiers" WHERE "isActive" = true LIMIT 1`);
      if (!active) return res.status(412).json({ error: 'No active classifier set. Activate one first.' });
      resolvedClsId = active.id;
    }

    const triggeredBy = req.user?.preferred_username || req.user?.name || 'system';
    const run = await db.queryOne(
      `INSERT INTO "ScoringRuns" ("classifierId", status, step, pct, "triggeredBy")
       VALUES ($1, 'pending', 'Queued', 0, $2)
       RETURNING *`,
      [resolvedClsId, triggeredBy]
    );

    // Fire-and-forget the scoring runner. Errors are captured into the row by
    // the engine itself, so we don't need to await it. Returning 202 lets the
    // UI start polling immediately without holding the HTTP connection open.
    runScoring(run.id, resolvedClsId).catch(err => {
      console.error(`Background scoring run ${run.id} crashed:`, err);
    });

    res.status(202).json(run);
  } catch (err) {
    console.error('start scoring run failed:', err.message);
    res.status(500).json({ error: 'Failed to start scoring run', message: err.message });
  }
});

router.get('/risk-scoring/runs', async (_req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.query(
      `SELECT id, "profileId", "classifierId", status, step, pct, "totalEntities", "scoredEntities",
              "errorMessage", "startedAt", "completedAt", "triggeredBy"
         FROM "ScoringRuns"
        ORDER BY "startedAt" DESC
        LIMIT 50`
    );
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'List failed' });
  }
});

router.get('/risk-scoring/runs/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await db.queryOne(`SELECT * FROM "ScoringRuns" WHERE id = $1`, [id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: 'Get failed' });
  }
});

export default router;
