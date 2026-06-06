// Identity Atlas — Account Linking API (deterministic, no LLM).
//
// Replaces the retired correlation-ruleset endpoints. Account linking attaches
// orphan accounts to existing Identities using an editable dictionary.
//
//   GET  /account-linking/config     — active config (or shipped defaults)
//   PUT  /account-linking/config     — upsert the single config row (admin)
//   POST /account-linking/runs       — start a run (202 + run row); runs in bg
//   GET  /account-linking/runs       — recent runs (newest first)
//   GET  /account-linking/runs/:id   — single-run status (polling UI)

import { Router } from 'express';
import * as db from '../db/connection.js';
import { runLinking } from '../accountlinking/engine.js';
import { DEFAULT_RULES } from '../accountlinking/defaultRules.js';
import { requirePermission } from '../middleware/auth.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
// Same gate as risk-scoring runs — configured + scheduled from the Admin area.
const gate = requirePermission('admin.crawlers');

// ─── Config (the editable dictionary + schedules) ─────────────────
router.get('/account-linking/config', async (_req, res) => {
  if (!useSql) return res.json({ id: null, rules: DEFAULT_RULES, schedules: [], isActive: true, defaults: true });
  try {
    const row = await db.queryOne(
      `SELECT * FROM "AccountLinkingConfig" WHERE "isActive" = true ORDER BY "updatedAt" DESC LIMIT 1`
    );
    if (!row) return res.json({ id: null, rules: DEFAULT_RULES, schedules: [], isActive: true, defaults: true });
    res.json({
      id: row.id, rules: row.rules, schedules: row.schedules,
      isActive: row.isActive, updatedAt: row.updatedAt, updatedBy: row.updatedBy,
    });
  } catch (err) {
    console.error('get account-linking config failed:', err.message);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

router.put('/account-linking/config', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { rules, schedules, isActive } = req.body || {};
  if (!rules || typeof rules !== 'object') return res.status(400).json({ error: 'rules object is required' });
  const updatedBy = req.user?.preferred_username || req.user?.name || 'system';
  try {
    // Single-row config: update the first row if present, else insert.
    const existing = await db.queryOne(`SELECT id FROM "AccountLinkingConfig" ORDER BY id ASC LIMIT 1`);
    let row;
    if (existing) {
      row = await db.queryOne(`
        UPDATE "AccountLinkingConfig"
           SET "rules" = $2, "schedules" = $3, "isActive" = $4,
               "updatedAt" = now() AT TIME ZONE 'utc', "updatedBy" = $5
         WHERE id = $1 RETURNING *`,
        [existing.id, JSON.stringify(rules), JSON.stringify(schedules || []), isActive !== false, updatedBy]);
    } else {
      row = await db.queryOne(`
        INSERT INTO "AccountLinkingConfig" ("rules", "schedules", "isActive", "updatedBy")
        VALUES ($1, $2, $3, $4) RETURNING *`,
        [JSON.stringify(rules), JSON.stringify(schedules || []), isActive !== false, updatedBy]);
    }
    res.json({
      id: row.id, rules: row.rules, schedules: row.schedules,
      isActive: row.isActive, updatedAt: row.updatedAt, updatedBy: row.updatedBy,
    });
  } catch (err) {
    console.error('save account-linking config failed:', err.message);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// ─── Runs ─────────────────────────────────────────────────────────
router.post('/account-linking/runs', gate, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const cfg = await db.queryOne(
      `SELECT id FROM "AccountLinkingConfig" WHERE "isActive" = true ORDER BY "updatedAt" DESC LIMIT 1`
    );
    const configId = cfg?.id ?? null;
    const triggeredBy = req.user?.preferred_username || req.user?.name || 'system';
    const run = await db.queryOne(
      `INSERT INTO "AccountLinkingRuns" ("configId", status, step, pct, "triggeredBy")
       VALUES ($1, 'pending', 'Queued', 0, $2) RETURNING *`,
      [configId, triggeredBy]
    );

    // Fire-and-forget — the engine records progress + errors into the row.
    runLinking(run.id, configId).catch(err => {
      console.error(`Background account-linking run ${run.id} crashed:`, err);
    });

    res.status(202).json(run);
  } catch (err) {
    console.error('start account-linking run failed:', err.message);
    res.status(500).json({ error: 'Failed to start run' });
  }
});

router.get('/account-linking/runs', async (_req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.query(`SELECT * FROM "AccountLinkingRuns" ORDER BY "startedAt" DESC LIMIT 50`);
    res.json({ data: r.rows });
  } catch (err) {
    console.error('list account-linking runs failed:', err.message);
    res.status(500).json({ error: 'List failed' });
  }
});

router.get('/account-linking/runs/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await db.queryOne(`SELECT * FROM "AccountLinkingRuns" WHERE id = $1`, [id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch (err) {
    console.error('get account-linking run failed:', err.message);
    res.status(500).json({ error: 'Get failed' });
  }
});

export default router;
