// Context roles — who answers for an organizational unit or a logical
// application. GET /api/contexts/:id/roles, PUT /contexts/:id/roles and
// DELETE /contexts/:id/roles/:roleId.
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
import { ROLE_BEARING_CATEGORIES } from '../../lib/contextCategories.js';

const router = Router();

// The templates that carry roles (lib/contextCategories.js).
export { ROLE_BEARING_CATEGORIES };

// Holder column → the table its display name comes from.
const HOLDER_TABLE = { principalId: 'Principals', identityId: 'Identities' };

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
// partial unique index for the holder column (migration 094).
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
    if (!holder) return res.status(404).json({ error: `${parsed.holderCol === 'principalId' ? 'Principal' : 'Identity'} not found` });

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

export default router;
