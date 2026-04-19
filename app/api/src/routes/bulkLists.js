// Bulk list endpoints for the join-table entities (ResourceAssignments,
// IdentityMembers, ResourceRelationships). The UI never needed flat
// listings of these — every existing route returns them scoped to a single
// resource/principal/identity. The Excel Power Query export does need the
// flat versions, so we add them here.
//
// All three follow the same shape: paginated (limit/offset, default 1000,
// max 10000), optional ?systemId filter, returns { data: [...], total: N }.
// Larger default page size than the entity list endpoints because Power
// Query is happiest when it can walk through fewer pages.

import { Router } from 'express';
import * as db from '../db/connection.js';

const router = Router();

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

function parsePaging(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const systemIdRaw = (req.query.systemId || '').toString().trim();
  const systemId = /^\d+$/.test(systemIdRaw) ? parseInt(systemIdRaw, 10) : null;
  return { limit, offset, systemId };
}

// Run the data + count queries in parallel against a single WHERE clause that
// uses $1 for the optional systemId. Each table picks its own column set; the
// rest is mechanical.
async function runListAndCount({ table, alias, columns, orderBy, dataWhere, countWhere, systemId, limit, offset }) {
  const dataParams = systemId !== null ? [systemId, limit, offset] : [limit, offset];
  const dataLimitOffset = systemId !== null ? '$2 OFFSET $3' : '$1 OFFSET $2';
  const countParams = systemId !== null ? [systemId] : [];

  const [list, count] = await Promise.all([
    db.query(
      `SELECT ${columns}
         FROM "${table}" ${alias}
         ${dataWhere}
        ORDER BY ${orderBy}
        LIMIT ${dataLimitOffset}`,
      dataParams
    ),
    db.queryOne(
      `SELECT COUNT(*)::int AS total FROM "${table}" ${alias} ${countWhere}`,
      countParams
    ),
  ]);
  return { data: list.rows, total: count?.total || 0 };
}

// ─── GET /api/assignments ────────────────────────────────────────
// Flat listing of "who has access to what" rows from ResourceAssignments.
router.get('/assignments', async (req, res) => {
  const { limit, offset, systemId } = parsePaging(req);
  try {
    const result = await runListAndCount({
      table: 'ResourceAssignments',
      alias: 'ra',
      columns: `ra."resourceId", ra."principalId", ra."assignmentType", ra."systemId",
                ra."principalType", ra."complianceState", ra."policyId", ra."state",
                ra."assignmentStatus", ra."expirationDateTime", ra."extendedAttributes"`,
      orderBy: `ra."resourceId", ra."principalId", ra."assignmentType"`,
      dataWhere:  systemId !== null ? `WHERE ra."systemId" = $1` : '',
      countWhere: systemId !== null ? `WHERE ra."systemId" = $1` : '',
      systemId, limit, offset,
    });
    res.json(result);
  } catch (err) {
    console.error('GET /assignments failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/identity-members ───────────────────────────────────
// Flat listing of identity ↔ principal links. Optional systemId filters by
// the principal's home system (IdentityMembers itself doesn't carry it).
router.get('/identity-members', async (req, res) => {
  const { limit, offset, systemId } = parsePaging(req);
  try {
    const where = systemId !== null
      ? `WHERE EXISTS (SELECT 1 FROM "Principals" p
                        WHERE p.id = im."principalId" AND p."systemId" = $1)`
      : '';
    const result = await runListAndCount({
      table: 'IdentityMembers',
      alias: 'im',
      columns: `im."identityId", im."principalId", im."isPrimary",
                im."isHrAuthoritative", im."accountType", im."accountTypePattern",
                im."accountEnabled", im."displayName"`,
      orderBy: `im."identityId", im."principalId"`,
      dataWhere: where, countWhere: where,
      systemId, limit, offset,
    });
    res.json(result);
  } catch (err) {
    console.error('GET /identity-members failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/resource-relationships ─────────────────────────────
// Flat listing of parent↔child resource links (Contains, GrantsAccessTo).
router.get('/resource-relationships', async (req, res) => {
  const { limit, offset, systemId } = parsePaging(req);
  try {
    const where = systemId !== null ? `WHERE rr."systemId" = $1` : '';
    const result = await runListAndCount({
      table: 'ResourceRelationships',
      alias: 'rr',
      columns: `rr."parentResourceId", rr."childResourceId", rr."relationshipType",
                rr."systemId", rr."roleName", rr."roleOriginSystem",
                rr."extendedAttributes"`,
      orderBy: `rr."parentResourceId", rr."childResourceId", rr."relationshipType"`,
      dataWhere: where, countWhere: where,
      systemId, limit, offset,
    });
    res.json(result);
  } catch (err) {
    console.error('GET /resource-relationships failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
