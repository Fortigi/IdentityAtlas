// Context roles — who answers for an organizational unit or a logical
// application. GET /api/contexts/:id/roles, PUT /contexts/:id/roles and
// DELETE /contexts/:id/roles/:roleId. Plus the best guess for a missing
// Accountable: GET /contexts/:id/roles/suggestion and
// POST /contexts/:id/roles/suggestion/reject (docs/architecture/template-ui.md).
//
// A role is Accountable (at most one per context) or Responsible (many) and
// points at an account (principalId) or a person (identityId), exactly one —
// the same choice ResourceAssignments makes. Roles live on OrganizationalUnit
// and LogicalApplication contexts only; a Segment or a Tag carries none.
// Roles written here are addedBy = 'analyst', which the plugin runner leaves
// alone on a re-run (it only replaces its own 'algorithm' roles).
// Design: docs/architecture/context-templates-phase-b.md.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { CONTEXT_ROLE_TYPES } from '../../ingest/validation.js';
import { useSql, UUID_RE, writeContexts } from './shared.js';
import { suggestAccountable } from '../../contexts/roleSuggestion.js';
import { userOf } from '../../lib/userOf.js';
import { ROLE_BEARING_CATEGORIES } from '../../lib/contextCategories.js';

const router = Router();

// The templates that carry roles (lib/contextCategories.js).
export { ROLE_BEARING_CATEGORIES };

// Holder column → the table its display name comes from.
export const HOLDER_TABLE = { principalId: 'Principals', identityId: 'Identities' };
const HOLDER_NOT_FOUND = { principalId: 'Principal not found', identityId: 'Identity not found' };

// Every role of one context, the Accountable first, with the holder's name
// resolved. Shared with GET /contexts/:id (read.js) so the detail page paints
// the People block without a second round trip.
export async function loadContextRoles(contextId) {
  const r = await db.query(`
    SELECT r.id, r.role, r."principalId", r."identityId", r."addedBy",
           COALESCE(p."displayName", i."displayName") AS "displayName"
      FROM "ContextRoles" r
      LEFT JOIN "Principals" p ON p.id = r."principalId"
      LEFT JOIN "Identities" i ON i.id = r."identityId"
     WHERE r."contextId" = $1
     ORDER BY (r.role = 'Accountable') DESC, "displayName"
  `, [contextId]);
  return r.rows;
}

// Body of PUT: { role, principalId | identityId }. Returns { status, message }
// on the first failure, else { role, holderCol, holderId }.
export function parseRoleBody(body) {
  if (!CONTEXT_ROLE_TYPES.includes(body.role)) {
    return { status: 400, message: `role must be one of ${CONTEXT_ROLE_TYPES.join(', ')}` };
  }
  const given = ['principalId', 'identityId'].filter(k => body[k] != null);
  if (given.length !== 1) return { status: 400, message: 'Exactly one of principalId or identityId is required' };
  const holderCol = given[0];
  if (!UUID_RE.test(String(body[holderCol]))) return { status: 400, message: `${holderCol} must be a uuid` };
  return { role: body.role, holderCol, holderId: String(body[holderCol]).toLowerCase() };
}

// Upsert the role as an analyst's. An Accountable replaces whichever
// Accountable the context had (the partial unique index allows only one); a
// Responsible is added next to the others. The conflict target names the
// partial unique index for the holder column (migration 092).
async function upsertRole(contextId, { role, holderCol, holderId }) {
  if (role === 'Accountable') {
    await db.query(`
      DELETE FROM "ContextRoles"
       WHERE "contextId" = $1 AND role = 'Accountable' AND "${holderCol}" IS DISTINCT FROM $2
    `, [contextId, holderId]);
  }
  const r = await db.query(`
    INSERT INTO "ContextRoles" ("contextId", "${holderCol}", role, "addedBy")
    VALUES ($1, $2, $3, 'analyst')
    ON CONFLICT ("contextId", "${holderCol}", role) WHERE "${holderCol}" IS NOT NULL
    DO UPDATE SET "addedBy" = 'analyst', "updatedAt" = (now() AT TIME ZONE 'utc')
    RETURNING id, role, "principalId", "identityId", "addedBy"
  `, [contextId, holderId, role]);
  return r.rows[0];
}

// ─── GET /api/contexts/:id/roles ─────────────────────────────────────
router.get('/contexts/:id/roles', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const ctx = await db.queryOne(`SELECT id FROM "Contexts" WHERE id = $1`, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });
    res.json(await loadContextRoles(req.params.id));
  } catch (err) {
    console.error('GET /contexts/:id/roles failed:', err.message);
    res.status(500).json({ error: 'Failed to load context roles' });
  }
});

// ─── PUT /api/contexts/:id/roles ─────────────────────────────────────
// Body: { role, principalId | identityId }. 404 when the context or the holder
// does not exist; 400 on a Segment or Tag context, which carry no roles.
router.put('/contexts/:id/roles', writeContexts, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const parsed = parseRoleBody(req.body || {});
  if (parsed.status) return res.status(parsed.status).json({ error: parsed.message });

  try {
    const ctx = await db.queryOne(`SELECT "contextCategory" FROM "Contexts" WHERE id = $1`, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });
    if (!ROLE_BEARING_CATEGORIES.has(ctx.contextCategory)) {
      return res.status(400).json({ error: 'Roles can only be set on an organizational unit or a logical application' });
    }
    const holder = await db.queryOne(
      `SELECT "displayName" FROM "${HOLDER_TABLE[parsed.holderCol]}" WHERE id = $1`, [parsed.holderId],
    );
    if (!holder) return res.status(404).json({ error: HOLDER_NOT_FOUND[parsed.holderCol] });

    const row = await upsertRole(req.params.id, parsed);
    res.json({ ...row, displayName: holder.displayName });
  } catch (err) {
    console.error('PUT /contexts/:id/roles failed:', err.message);
    res.status(500).json({ error: 'Failed to set context role' });
  }
});

// ─── DELETE /api/contexts/:id/roles/:roleId ──────────────────────────
router.delete('/contexts/:id/roles/:roleId', writeContexts, async (req, res) => {
  const { id, roleId } = req.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(roleId)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.query(`DELETE FROM "ContextRoles" WHERE id = $1 AND "contextId" = $2`, [roleId, id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Role not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /contexts/:id/roles/:roleId failed:', err.message);
    res.status(500).json({ error: 'Failed to remove context role' });
  }
});

// ─── GET /api/contexts/:id/roles/suggestion ──────────────────────────
// 200 { role: 'Accountable', principalId | identityId, displayName, reason,
// count, total }, or 204 when the context already has an Accountable, its
// template carries no roles, or no signal gives a candidate.
router.get('/contexts/:id/roles/suggestion', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(204).end();
  try {
    const ctx = await db.queryOne(`
      SELECT c.id, c."contextCategory", c."targetType",
             EXISTS (SELECT 1 FROM "ContextRoles" r
                      WHERE r."contextId" = c.id AND r.role = 'Accountable') AS "hasAccountable"
        FROM "Contexts" c WHERE c.id = $1
    `, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });
    if (ctx.hasAccountable || !ROLE_BEARING_CATEGORIES.has(ctx.contextCategory)) return res.status(204).end();
    const suggestion = await suggestAccountable(ctx);
    if (!suggestion) return res.status(204).end();
    res.json(suggestion);
  } catch (err) {
    console.error('GET /contexts/:id/roles/suggestion failed:', err.message);
    res.status(500).json({ error: 'Failed to suggest a context role' });
  }
});

// ─── POST /api/contexts/:id/roles/suggestion/reject ──────────────────
// Body: { principalId | identityId }. Remembers that this holder is not the
// context's Accountable, so the suggestion never offers them again. 204, also
// when the rejection was already stored.
router.post('/contexts/:id/roles/suggestion/reject', writeContexts, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const body = req.body || {};
  const parsed = parseRoleBody({ role: 'Accountable', principalId: body.principalId, identityId: body.identityId });
  if (parsed.status) return res.status(parsed.status).json({ error: parsed.message });
  const { holderCol, holderId } = parsed;

  try {
    const ctx = await db.queryOne(`SELECT id FROM "Contexts" WHERE id = $1`, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });
    const holder = await db.queryOne(`SELECT id FROM "${HOLDER_TABLE[holderCol]}" WHERE id = $1`, [holderId]);
    if (!holder) return res.status(404).json({ error: HOLDER_NOT_FOUND[holderCol] });

    await db.query(`
      INSERT INTO "ContextRoleSuggestionRejections" ("contextId", "${holderCol}", role, "rejectedBy")
      VALUES ($1, $2, 'Accountable', $3)
      ON CONFLICT ("contextId", "${holderCol}", role) WHERE "${holderCol}" IS NOT NULL DO NOTHING
    `, [req.params.id, holderId, userOf(req)]);
    res.status(204).end();
  } catch (err) {
    console.error('POST /contexts/:id/roles/suggestion/reject failed:', err.message);
    res.status(500).json({ error: 'Failed to reject the suggestion' });
  }
});

export default router;
