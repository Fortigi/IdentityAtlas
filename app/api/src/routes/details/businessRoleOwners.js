// Accountable and Responsible on a business role.
//
//   GET    /api/access-package/:id/owners
//   GET    /api/access-package/:id/owners/suggestions
//   GET    /api/access-package/:id/participants       approvers, reviewers, request scope
//   PUT    /api/access-package/:id/owners             { role, principalId | identityId }
//   DELETE /api/access-package/:id/owners/:ownerId
//   POST   /api/access-package/:id/owners/suggestions/reject  { role, principalId }
//
// Writes take the permission that edits who answers for a context.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE } from './shared.js';
import { writeContexts } from '../contexts/shared.js';
import { parseRoleBody, HOLDER_TABLE } from '../contexts/roles.js';
import { userOf } from '../../lib/userOf.js';
import {
  loadBusinessRoleOwners, setBusinessRoleOwner, removeBusinessRoleOwner, isBusinessRole,
} from '../../lib/businessRoleOwners.js';
import { suggestBusinessRoleOwners } from '../../lib/businessRoleOwnerSuggestion.js';
import { loadParticipants, withPolicyResponsible } from '../../lib/businessRolePeople.js';

const router = Router();

const requireRole = async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    if (!(await isBusinessRole(req.params.id))) return res.status(404).json({ error: 'Business role not found' });
    return next();
  } catch (err) {
    console.error('business role lookup failed:', err.message);
    return res.status(500).json({ error: 'Failed to load the business role' });
  }
};

const failed = (res, label, err) => {
  console.error(`${label} failed:`, err.message);
  res.status(500).json({ error: `${label} failed` });
};

router.get('/access-package/:id/owners', requireRole, async (req, res) => {
  try {
    const [owners, participants] = await Promise.all([loadBusinessRoleOwners(req.params.id), loadParticipants(req.params.id)]);
    res.json(withPolicyResponsible(owners, participants));
  } catch (err) { failed(res, 'Loading the owners', err); }
});

router.get('/access-package/:id/participants', requireRole, async (req, res) => {
  try { res.json(await loadParticipants(req.params.id)); }
  catch (err) { failed(res, 'Loading approvers and reviewers', err); }
});

router.get('/access-package/:id/owners/suggestions', requireRole, async (req, res) => {
  try {
    const [stored, participants] = await Promise.all([loadBusinessRoleOwners(req.params.id), loadParticipants(req.params.id)]);
    res.json(await suggestBusinessRoleOwners(req.params.id, withPolicyResponsible(stored, participants), participants));
  } catch (err) { failed(res, 'Suggesting owners', err); }
});

router.put('/access-package/:id/owners', writeContexts, requireRole, async (req, res) => {
  const parsed = parseRoleBody(req.body || {});
  if (parsed.status) return res.status(parsed.status).json({ error: parsed.message });
  try {
    const holder = await db.queryOne(`SELECT "displayName" FROM "${HOLDER_TABLE[parsed.holderCol]}" WHERE id = $1`, [parsed.holderId]);
    if (!holder) return res.status(404).json({ error: 'That person or account was not found' });
    const row = await setBusinessRoleOwner(req.params.id, parsed, 'analyst');
    return res.json({ ...row, displayName: holder.displayName });
  } catch (err) { return failed(res, 'Setting the owner', err); }
});

router.delete('/access-package/:id/owners/:ownerId', writeContexts, requireRole, async (req, res) => {
  if (!UUID_RE.test(req.params.ownerId)) return res.status(400).json({ error: 'Invalid ID format' });
  try {
    if (!(await removeBusinessRoleOwner(req.params.id, req.params.ownerId))) return res.status(404).json({ error: 'Owner not found' });
    return res.status(204).end();
  } catch (err) { return failed(res, 'Removing the owner', err); }
});

router.post('/access-package/:id/owners/suggestions/reject', writeContexts, requireRole, async (req, res) => {
  const body = req.body || {};
  const parsed = parseRoleBody({ role: body.role, principalId: body.principalId });
  if (parsed.status) return res.status(parsed.status).json({ error: parsed.message });
  try {
    const holder = await db.queryOne(`SELECT id FROM "Principals" WHERE id = $1`, [parsed.holderId]);
    if (!holder) return res.status(404).json({ error: 'That account was not found' });
    await db.query(`
      INSERT INTO "BusinessRoleOwnerRejections" ("resourceId", "principalId", role, "rejectedBy")
      VALUES ($1, $2, $3, $4)
      ON CONFLICT ("resourceId", "principalId", role) DO NOTHING
    `, [req.params.id, parsed.holderId, parsed.role, userOf(req)]);
    return res.status(204).end();
  } catch (err) { return failed(res, 'Rejecting the suggestion', err); }
});

export default router;
