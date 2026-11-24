// Owners of business roles stated by a crawler: POST /api/ingest/business-role-owners.
//
// Envelope: { systemId, records: [{ resourceExternalId, role, holder, holderName? }] }.
// `holder` is a key (external id, e-mail, employee id). `holderName` is used only
// when the "also match owners by name" setting is on: a name is a guess an
// operator opts into, the same rule as a context's source owner.
//
// A crawler may only touch roles of systems its key can write. Written as
// 'sync': it fills an empty place or follows an earlier sync row, and never
// replaces what a person chose or uploaded (lib/businessRoleOwners.js).

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { crawlerHasPermission, crawlerHasSystemAccess } from '../../middleware/crawlerAuth.js';
import { parseLinkEnvelope } from './contextLinks.js';
import { matchAll } from '../../contexts/upload/members.js';
import { isFeatureEnabled } from '../../featureFlags.js';
import { OWNER_ROLES, setBusinessRoleOwner } from '../../lib/businessRoleOwners.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

export function parseOwnerRecords(records) {
  const rows = [];
  for (const [i, rec] of records.entries()) {
    const r = rec && typeof rec === 'object' ? rec : {};
    if (!r.resourceExternalId) return { status: 400, message: `records[${i}]: resourceExternalId is required` };
    if (!OWNER_ROLES.includes(r.role)) return { status: 400, message: `records[${i}]: role must be one of ${OWNER_ROLES.join(', ')}` };
    if (!r.holder) return { status: 400, message: `records[${i}]: holder is required` };
    rows.push({
      resourceExternalId: String(r.resourceExternalId),
      role: r.role,
      holder: String(r.holder),
      holderName: r.holderName ? String(r.holderName) : null,
    });
  }
  return { rows };
}

// externalId → resource id, for the roles this crawler may write. An external id
// two writable roles share is left out rather than guessed.
export async function resolveRoles(req, externalIds) {
  const { rows } = await db.query(`
    SELECT id, "externalId", "systemId" FROM "Resources"
     WHERE "externalId" = ANY($1::text[]) AND "resourceType" = 'BusinessRole' AND "deletedAt" IS NULL
  `, [externalIds]);
  const found = new Map();
  for (const r of rows.filter(row => crawlerHasSystemAccess(req, row.systemId))) {
    found.set(r.externalId, found.has(r.externalId) ? null : r.id);
  }
  return found;
}

async function resolveHolders(rows) {
  const byName = await isFeatureEnabled('sourceOwnerNameMatch');
  const values = rows.flatMap(r => (byName && r.holderName ? [r.holder, r.holderName] : [r.holder]));
  const { ids } = await matchAll(db, { Principal: [...new Set(values)] });
  const people = ids.Principal ?? new Map();
  return (row) => people.get(row.holder) ?? (byName && row.holderName ? people.get(row.holderName) : undefined) ?? null;
}

export async function writeOwnerRows(req, rows) {
  const roles = await resolveRoles(req, [...new Set(rows.map(r => r.resourceExternalId))]);
  const holderOf = await resolveHolders(rows);
  const out = { written: 0, skipped: 0, unmatched: 0 };
  for (const row of rows) {
    const resourceId = roles.get(row.resourceExternalId);
    const holderId = holderOf(row);
    if (!resourceId || !holderId) { out.unmatched++; continue; }
    const saved = await setBusinessRoleOwner(resourceId, { role: row.role, holderCol: 'principalId', holderId }, 'sync');
    if (saved) out.written++; else out.skipped++;
  }
  return out;
}

router.post('/ingest/business-role-owners', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!crawlerHasPermission(req, 'ingest')) return res.status(403).json({ error: 'Insufficient permissions' });
  const env = parseLinkEnvelope(req.body);
  if (env.status) return res.status(env.status).json({ error: env.message });
  if (!crawlerHasSystemAccess(req, env.systemId)) return res.status(403).json({ error: `Crawler does not have access to system ${env.systemId}` });
  const parsed = parseOwnerRecords(env.records);
  if (parsed.status) return res.status(parsed.status).json({ error: parsed.message });
  try {
    return res.json(await writeOwnerRows(req, parsed.rows));
  } catch (err) {
    console.error('POST ingest/business-role-owners failed:', err.message);
    return res.status(500).json({ error: 'Failed to ingest business role owners' });
  }
});

export default router;
