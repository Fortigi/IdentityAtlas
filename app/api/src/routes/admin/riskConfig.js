// Read-only risk-config endpoints — /api/admin/risk-profile and
// /api/admin/classifiers (the active v5 RiskProfiles / RiskClassifiers rows).
//
// Extracted verbatim from routes/admin.js (audit finding C1). Mounted by
// routes/admin.js via router.use(), so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// ── GET /api/admin/risk-profile ───────────────────────────────────
// Returns the active v5 risk profile (or the most recent one if none is active).
// v5 moved off the legacy GraphRiskProfiles table — profiles now live in
// RiskProfiles and are created by the in-browser wizard (Admin → Risk Scoring →
// New profile). The response shape is kept compatible with the existing
// AdminPage renderer: domain/industry/country are promoted to top-level fields,
// `profile` carries the full structured customer_profile object.
router.get('/admin/risk-profile', async (req, res) => {
  if (!useSql) return res.json({ available: false });

  try {
    const r = await db.query(`
      SELECT id, "displayName", domain, industry, country, "llmProvider", "llmModel",
             version, "isActive", "createdAt", "updatedAt", profile
        FROM "RiskProfiles"
        ORDER BY "isActive" DESC, "createdAt" DESC
        LIMIT 1
    `);

    if (r.rows.length === 0) {
      return res.json({ available: false });
    }

    const row = r.rows[0];
    res.json({
      available: true,
      source: 'sql',
      id: row.id,
      displayName: row.displayName,
      domain: row.domain || row.profile?.domain || null,
      industry: row.industry || row.profile?.industry || null,
      country: row.country || row.profile?.country || null,
      llmProvider: row.llmProvider,
      llmModel: row.llmModel,
      version: row.version,
      isActive: row.isActive,
      generatedAt: row.createdAt,
      profile: row.profile, // jsonb parsed by pg
    });
  } catch (err) {
    console.error('Error fetching risk profile:', err.message);
    res.json({ available: false });
  }
});

// ── GET /api/admin/classifiers ────────────────────────────────────
// Returns the active v5 classifier set (or the most recent one if none active).
// Like /admin/risk-profile, this reads from the v5 RiskClassifiers table used
// by the wizard, not the retired GraphRiskClassifiers table.
router.get('/admin/classifiers', async (req, res) => {
  if (!useSql) return res.json({ available: false });

  try {
    const r = await db.query(`
      SELECT id, "profileId", "displayName", "llmProvider", "llmModel", version,
             "isActive", "createdAt", "updatedAt", classifiers, schedules
        FROM "RiskClassifiers"
        ORDER BY "isActive" DESC, "createdAt" DESC
        LIMIT 1
    `);
    if (r.rows.length === 0) return res.json({ available: false });

    const row = r.rows[0];
    res.json({
      available: true,
      source: 'sql',
      id: row.id,
      profileId: row.profileId,
      displayName: row.displayName,
      version: row.version,
      isActive: row.isActive,
      generatedAt: row.createdAt,
      llmProvider: row.llmProvider,
      llmModel: row.llmModel,
      classifiers: row.classifiers, // jsonb parsed by pg
      schedules: row.schedules || [], // jsonb parsed by pg
    });
  } catch (err) {
    console.error('Error fetching classifiers:', err.message);
    res.json({ available: false });
  }
});

export default router;
