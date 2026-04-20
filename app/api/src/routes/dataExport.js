// Read-only API tokens + Excel Power Query workbook download.
//
// Two distinct flows live behind /api/admin/data-export/*:
//
//   1. Token CRUD — create / list / revoke read API keys (`fgr_…`). Used by
//      operators who want to plug Identity Atlas into other tools (Power BI,
//      curl, custom scripts).
//
//   2. Workbook download — convenience flow that creates a token AND returns
//      a pre-stamped Excel workbook in a single request, so a data analyst
//      can go from "I want my data in Excel" to a working pivot table in
//      under a minute.
//
// Both flows are guarded by authMiddleware (mounted in index.js) and are
// admin-scoped — the auth middleware additionally rejects `fgr_` tokens for
// any /api/admin/* path, so a stolen read token can't mint more tokens.

import { Router } from 'express';
import { createToken, listTokens, revokeToken } from '../auth/readTokens.js';
import { generateWorkbook } from '../export/excelWorkbook.js';

const router = Router();

// ─── GET /api/admin/read-tokens ─────────────────────────────────
router.get('/admin/read-tokens', async (_req, res) => {
  try {
    res.json(await listTokens());
  } catch (err) {
    console.error('list read tokens failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/admin/read-tokens ────────────────────────────────
// Body: { name: string, expiresAt?: ISO date }
// Returns: { token: 'fgr_…' (one-time), row: { id, name, ... } }
router.post('/admin/read-tokens', async (req, res) => {
  try {
    const { name, expiresAt } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.length > 200) return res.status(400).json({ error: 'name too long' });
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
      return res.status(400).json({ error: 'expiresAt must be a valid ISO timestamp' });
    }
    const createdBy = req.user?.preferred_username || req.user?.email || 'unknown';
    const result = await createToken({ name: name.trim(), createdBy, expiresAt });
    res.status(201).json(result);
  } catch (err) {
    console.error('create read token failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/admin/read-tokens/:id ──────────────────────────
router.delete('/admin/read-tokens/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const ok = await revokeToken(id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('revoke read token failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/admin/data-export/workbook ───────────────────────
// One-click flow: create a new read token AND return the pre-stamped
// .xlsx in the same request. Body: { name?: string }. Default name is
// derived from the requesting user / timestamp.
router.post('/admin/data-export/workbook', async (req, res) => {
  try {
    const requestedName = (req.body?.name && String(req.body.name).trim()) || '';
    const createdBy = req.user?.preferred_username || req.user?.email || 'unknown';
    const tokenName = requestedName || `Excel workbook (${createdBy}, ${new Date().toISOString().slice(0, 10)})`;

    const { token } = await createToken({ name: tokenName.slice(0, 200), createdBy });

    // The workbook embeds the API base URL so the same file works against
    // whatever host actually generated it (compose stack, prod deployment,
    // tunnel, etc). Honour X-Forwarded-* if present, otherwise fall back
    // to the request host.
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    const apiBaseUrl = `${proto}://${host}/api`;

    const buffer = await generateWorkbook({ apiBaseUrl, token });

    const filename = `IdentityAtlas-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    console.error('workbook generation failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
