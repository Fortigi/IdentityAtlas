// Saved matrix filters CRUD + the org-wide default filter.
//
// Extracted verbatim from routes/matrix.js as part of splitting that god-module
// (audit finding Q1). Mounted by routes/matrix.js via `router.use(...)`, so the
// public paths are unchanged: /api/matrix/saved-filters[/...] and
// /api/matrix/default-filter.
//
// Org-wide visibility is intentional (see migration 023): every signed-in
// analyst can list, load, rename, and delete every saved filter. fgr_ read
// tokens cannot reach these (the auth middleware is GET-only for them) and every
// write is attributed via createdBy/updatedBy.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as db from '../../db/connection.js';
import { UUID_RE } from '../../matrix/filterSql.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

function getActor(req) {
  return (req.user && (req.user.email || req.user.upn || req.user.name)) || 'unknown';
}

router.get('/matrix/saved-filters', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const r = await db.query(`
      SELECT id, "name", "description", "filter", "isDefault", "createdBy", "createdAt", "updatedBy", "updatedAt"
        FROM "SavedMatrixFilters"
       ORDER BY LOWER("name")
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('GET matrix/saved-filters failed:', err.message);
    res.status(500).json({ error: 'Failed to list saved filters' });
  }
});

router.post('/matrix/saved-filters', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  const description = typeof body.description === 'string' ? body.description.slice(0, 1000) : null;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!body.filter || typeof body.filter !== 'object') return res.status(400).json({ error: 'filter is required' });

  try {
    const id = randomUUID();
    const actor = getActor(req);
    await db.query(
      `INSERT INTO "SavedMatrixFilters" (id, "name", "description", "filter", "createdBy", "updatedBy")
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, name, description, body.filter, actor],
    );
    const row = await db.queryOne(`SELECT * FROM "SavedMatrixFilters" WHERE id = $1`, [id]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `A filter named "${name}" already exists` });
    }
    console.error('POST matrix/saved-filters failed:', err.message);
    res.status(500).json({ error: 'Failed to save filter' });
  }
});

router.put('/matrix/saved-filters/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const body = req.body || {};
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`"${col}" = $${params.length}`); };

  if (typeof body.name === 'string') push('name', body.name.trim().slice(0, 200));
  if (typeof body.description === 'string' || body.description === null) {
    push('description', body.description ? body.description.slice(0, 1000) : null);
  }
  if (body.filter && typeof body.filter === 'object') push('filter', body.filter);
  if (typeof body.isDefault === 'boolean') push('isDefault', body.isDefault);
  if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields' });

  push('updatedBy', getActor(req));
  push('updatedAt', new Date());
  params.push(req.params.id);
  try {
    const r = await db.query(
      `UPDATE "SavedMatrixFilters" SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Filter not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A filter with that name already exists' });
    }
    console.error('PUT matrix/saved-filters/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to update filter' });
  }
});

router.delete('/matrix/saved-filters/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await db.query(`DELETE FROM "SavedMatrixFilters" WHERE id = $1`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Filter not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE matrix/saved-filters/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete filter' });
  }
});

// ─── Default filter (auto-apply on first Matrix visit) ──────────────

router.get('/matrix/default-filter', async (req, res) => {
  if (!useSql) return res.json(null);
  try {
    const row = await db.queryOne(
      `SELECT id, "name", "description", "filter", "isDefault", "createdBy", "createdAt", "updatedBy", "updatedAt"
         FROM "SavedMatrixFilters" WHERE "isDefault" = true LIMIT 1`
    );
    res.json(row || null);
  } catch (err) {
    console.error('GET matrix/default-filter failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch default filter' });
  }
});

export default router;
