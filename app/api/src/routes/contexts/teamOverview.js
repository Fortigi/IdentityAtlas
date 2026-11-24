// GET /api/contexts/:id/team-overview — who in a unit holds which business role,
// how many of their permissions no role covers, and what changed recently
// (contexts/teamOverview.js). For a context owner the id must be in their scope
// (auth/contextOwnerScope.js).

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE } from './shared.js';
import { loadMembers } from './read.js';
import { loadTeamOverview } from '../../contexts/teamOverview.js';
import { loadUngoverned } from '../../contexts/teamUngoverned.js';
import { findContextMember } from '../../contexts/memberReferences.js';
import { orgKnowledgeEnabled } from '../../featureFlags.js';

const router = Router();
const PEOPLE_TARGETS = new Set(['Principal', 'Identity']);
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export function overviewDays(value) {
  const n = parseInt(value, 10);
  if (!n || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

router.get('/contexts/:id/team-overview', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  const sinceDays = overviewDays(req.query.sinceDays);
  if (!useSql) return res.json({ sinceDays, people: [], roles: [], changes: [], totalPeople: 0, truncated: false });
  try {
    const ctx = await db.queryOne(`SELECT id, "targetType", "contextCategory" FROM "Contexts" WHERE id = $1`, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });
    if (ctx.contextCategory !== 'OrganizationalUnit' || !PEOPLE_TARGETS.has(ctx.targetType)) {
      return res.status(400).json({ error: 'The team overview is for an organizational unit of people.' });
    }
    const includeOverridden = !(await orgKnowledgeEnabled());
    res.json(await loadTeamOverview({ db, loadMembers }, ctx, { sinceDays, includeOverridden }));
  } catch (err) {
    console.error('GET /contexts/:id/team-overview failed:', err.message);
    res.status(500).json({ error: 'Failed to load the team overview' });
  }
});

// One direct member's ungoverned permissions. A member of another context is a
// 404 for every reader; for an owner the allow-list has already checked the same.
router.get('/contexts/:id/team-overview/:memberId/ungoverned', async (req, res) => {
  const { id, memberId } = req.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(memberId)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ items: [], truncated: false });
  try {
    const member = await findContextMember(await db.getPool(), id, memberId);
    if (!member) return res.status(404).json({ error: 'Not a member of this context' });
    res.json(await loadUngoverned(db, memberId));
  } catch (err) {
    console.error('GET /contexts/:id/team-overview/:memberId/ungoverned failed:', err.message);
    res.status(500).json({ error: 'Failed to load the ungoverned permissions' });
  }
});

export default router;
