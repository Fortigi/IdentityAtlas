// GET /api/contexts/:id/members/:memberId/references — one member's direct
// references, names only (contexts/memberReferences.js).
//
// Answers only for an actual member of the context: a member id from anywhere
// else is a 404, whoever asks. For a context owner the allow-list makes the same
// check before the request gets here (auth/contextOwnerScope.js +
// middleware/contextOwnerMode.js) — that is the access decision; this one keeps
// the endpoint meaning "a member of THIS context" for every reader.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE } from './shared.js';
import { findContextMember, loadMemberReferences } from '../../contexts/memberReferences.js';

const router = Router();

router.get('/contexts/:id/members/:memberId/references', async (req, res) => {
  const { id, memberId } = req.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(memberId)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ memberType: null, groups: [] });

  try {
    const pool = await db.getPool();
    const member = await findContextMember(pool, id, memberId);
    if (!member) return res.status(404).json({ error: 'Not a member of this context' });
    res.json(await loadMemberReferences(pool, id, member.memberType, memberId));
  } catch (err) {
    console.error('GET /contexts/:id/members/:memberId/references failed:', err.message);
    res.status(500).json({ error: 'Failed to load member references' });
  }
});

export default router;
