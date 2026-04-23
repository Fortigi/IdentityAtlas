// Context-algorithm plugin API routes.
//
// GET  /api/context-plugins             — list registered plugins (joined with ContextAlgorithms)
// POST /api/context-plugins/:name/dry-run — return counts + samples without writing
// POST /api/context-plugins/:name/run   — queue a run, return runId, execute async
// GET  /api/context-plugins/runs        — recent runs, newest first
// GET  /api/context-plugins/runs/:id    — single run status

import { Router } from 'express';
import * as db from '../db/connection.js';
import { REGISTERED_PLUGINS, getPlugin } from '../contexts/plugins/registry.js';
import { enqueueRun, dryRun, getRun, listRuns } from '../contexts/plugins/runner.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/context-plugins
router.get('/context-plugins', async (req, res) => {
  if (!useSql) return res.json({ data: REGISTERED_PLUGINS.map(stripPlugin), total: REGISTERED_PLUGINS.length });
  try {
    const rows = (await db.query(`
      SELECT id, name, "displayName", description, "targetType", "parametersSchema", enabled, "createdAt"
        FROM "ContextAlgorithms"
       ORDER BY "targetType", "displayName"
    `)).rows;
    // Overlay in-process plugin metadata so a plugin that has been updated
    // in code shows the new description even before seedAlgorithms re-runs.
    const byName = new Map(rows.map(r => [r.name, r]));
    const merged = REGISTERED_PLUGINS.map(p => {
      const db = byName.get(p.name);
      return {
        id: db?.id || null,
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        targetType: p.targetType,
        parametersSchema: p.parametersSchema,
        enabled: db?.enabled ?? true,
        registered: true,
      };
    });
    res.json({ data: merged, total: merged.length });
  } catch (err) {
    console.error('GET /context-plugins failed:', err.message);
    res.status(500).json({ error: 'Failed to load plugins' });
  }
});

// POST /api/context-plugins/:name/dry-run
router.post('/context-plugins/:name/dry-run', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const plugin = getPlugin(req.params.name);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
  try {
    const out = await dryRun(plugin.name, req.body || {});
    res.json(out);
  } catch (err) {
    console.error(`POST /context-plugins/${req.params.name}/dry-run failed:`, err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/context-plugins/:name/run
router.post('/context-plugins/:name/run', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const plugin = getPlugin(req.params.name);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
  const triggeredBy = (req.user && (req.user.email || req.user.upn || req.user.name)) || 'unknown';
  try {
    const runId = await enqueueRun(plugin.name, req.body || {}, triggeredBy);
    res.status(202).json({ runId, status: 'queued' });
  } catch (err) {
    console.error(`POST /context-plugins/${req.params.name}/run failed:`, err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/context-plugins/runs
router.get('/context-plugins/runs', async (req, res) => {
  if (!useSql) return res.json({ data: [], total: 0 });
  try {
    const rows = await listRuns({
      algorithmId: req.query.algorithmId || null,
      limit: req.query.limit,
    });
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /context-plugins/runs failed:', err.message);
    res.status(500).json({ error: 'Failed to load runs' });
  }
});

// GET /api/context-plugins/runs/:id
router.get('/context-plugins/runs/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid run id' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const row = await getRun(req.params.id);
    if (!row) return res.status(404).json({ error: 'Run not found' });
    res.json(row);
  } catch (err) {
    console.error('GET /context-plugins/runs/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to load run' });
  }
});

function stripPlugin(p) {
  return {
    name: p.name, displayName: p.displayName, description: p.description,
    targetType: p.targetType, parametersSchema: p.parametersSchema, enabled: true, registered: true,
  };
}

export default router;
