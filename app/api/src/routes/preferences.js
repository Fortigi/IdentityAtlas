// Per-user UI preferences (visible tabs).
// Identified by Entra ID `oid` claim when auth is on, 'anonymous' otherwise.

import { Router } from 'express';
import * as db from '../db/connection.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

const OPTIONAL_TABS = ['risk-scores', 'identities', 'org-chart', 'performance', 'admin'];

function getUserId(req) {
  if (req.user?.oid) return req.user.oid;
  return 'anonymous';
}

function getUserInfo(req) {
  return {
    displayName: req.user?.name || req.user?.preferred_username || null,
    email: req.user?.preferred_username || req.user?.upn || null,
  };
}

router.get('/preferences', async (req, res) => {
  const defaults = { visibleTabs: [] };
  if (!useSql) return res.json(defaults);

  try {
    const userId = getUserId(req);
    const row = await db.queryOne(
      `SELECT "visibleTabs" FROM "GraphUserPreferences" WHERE "userId" = $1`,
      [userId]
    );
    if (!row) return res.json(defaults);

    // jsonb column comes back as a JS array already
    const visibleTabs = Array.isArray(row.visibleTabs)
      ? row.visibleTabs.filter(t => OPTIONAL_TABS.includes(t))
      : [];
    res.json({ visibleTabs });
  } catch (err) {
    console.error('Error fetching preferences:', err.message);
    res.json(defaults);
  }
});

router.put('/preferences', async (req, res) => {
  if (!useSql) return res.json({ ok: true });

  try {
    const userId = getUserId(req);
    const { displayName, email } = getUserInfo(req);

    let visibleTabs = req.body.visibleTabs;
    if (!Array.isArray(visibleTabs)) {
      return res.status(400).json({ error: 'visibleTabs must be an array' });
    }
    visibleTabs = visibleTabs.filter(t => OPTIONAL_TABS.includes(t));

    await db.query(
      `INSERT INTO "GraphUserPreferences" ("userId", "displayName", "email", "visibleTabs", "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, now() AT TIME ZONE 'utc')
       ON CONFLICT ("userId") DO UPDATE
         SET "displayName" = EXCLUDED."displayName",
             "email"       = EXCLUDED."email",
             "visibleTabs" = EXCLUDED."visibleTabs",
             "updatedAt"   = EXCLUDED."updatedAt"`,
      [userId, displayName, email, JSON.stringify(visibleTabs)]
    );

    res.json({ ok: true, visibleTabs });
  } catch (err) {
    console.error('Error saving preferences:', err.message);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

export { OPTIONAL_TABS };
export default router;
