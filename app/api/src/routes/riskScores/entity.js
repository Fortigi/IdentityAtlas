// Single-entity risk-score endpoints — GET /api/risk-scores/:type/:id and the
// analyst-override PUT/DELETE on /risk-scores/:type/:id/override.
//
// Extracted verbatim from routes/riskScores.js (audit finding C1). Mounted by
// routes/riskScores.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import { timedRequest } from '../../perf/sqlTimer.js';
import { requirePermission } from '../../middleware/auth.js';
import { tierFor } from '../../riskscoring/tiers.js';
import { useSql, db, riskTableExists, parseJsonColumns, TEMPORAL_FILTER } from './shared.js';

const router = Router();
const writeRisk = requirePermission('data.write.risk');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TYPES = new Set(['users', 'groups', 'resources', 'business-roles', 'contexts', 'identities']);

// Map URL path type to RiskScores.entityType
function mapEntityType(urlType) {
  switch (urlType) {
    case 'users':          return 'Principal';
    case 'groups':
    case 'resources':      return 'Resource';
    case 'business-roles': return 'BusinessRole';
    case 'contexts':       return 'Context';
    case 'identities':     return 'Identity';
    default:               return null;
  }
}

// Shared preamble for all three :type/:id handlers: require SQL mode and validate
// the path params. On any failure it sends the 400 and returns null (caller
// should `return`); otherwise returns { type, id, entityType }.
function parseEntityParams(req, res) {
  if (!useSql) { res.status(400).json({ error: 'SQL mode required' }); return null; }
  const { type, id } = req.params;
  if (!VALID_TYPES.has(type)) {
    res.status(400).json({ error: `Type must be one of: ${[...VALID_TYPES].join(', ')}` });
    return null;
  }
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid entity ID format' });
    return null;
  }
  return { type, id, entityType: mapEntityType(type) };
}

// Read the four component scores for an entity and recompute its effective score
// (clamped 0–100) plus tier, applying `adjustment` (0 for a clear). On a missing
// row it sends the 404 and returns null; otherwise returns { newScore, newTier }.
async function recomputeScore(p, res, id, entityType, adjustment = 0) {
  const current = await timedRequest(p, 'risk-override-read', res)
    .input('id', id)
    .input('entityType', entityType)
    .query(`
        SELECT "riskDirectScore", "riskMembershipScore", "riskStructuralScore", "riskPropagatedScore"
        FROM "RiskScores"
        WHERE "entityId" = @id AND "entityType" = @entityType
      `);

  if (current.recordset.length === 0) {
    res.status(404).json({ error: 'Entity not found or not yet scored' });
    return null;
  }

  const row = current.recordset[0];
  const baseScore = (row.riskDirectScore || 0) + (row.riskMembershipScore || 0)
    + (row.riskStructuralScore || 0) + (row.riskPropagatedScore || 0);
  const newScore = Math.max(0, Math.min(100, baseScore + adjustment));
  return { newScore, newTier: tierFor(newScore) };
}

// Denormalize a recomputed score/tier onto the entity's own table (best-effort —
// the entity table may not carry risk columns yet, so failures are swallowed).
async function denormalizeScore(p, res, id, entityType, newScore, newTier) {
  try {
    if (entityType === 'Principal') {
      await timedRequest(p, 'risk-override-denorm', res)
        .input('id', id).input('newScore', newScore).input('newTier', newTier)
        .query(`UPDATE "Principals" SET "riskScore" = @newScore, "riskTier" = @newTier WHERE id = @id`);
    } else if (entityType === 'Resource') {
      await timedRequest(p, 'risk-override-denorm', res)
        .input('id', id).input('newScore', newScore).input('newTier', newTier)
        .query(`UPDATE "Resources" SET "riskScore" = @newScore, "riskTier" = @newTier WHERE id = @id`);
    }
  } catch { /* entity table may not have risk columns yet */ }
}

// ─── GET /api/risk-scores/:type/:id ──────────────────────────────────
router.get('/risk-scores/:type/:id', async (req, res) => {
  try {
    const parsed = parseEntityParams(req, res);
    if (!parsed) return;
    const { id, entityType } = parsed;

    const p = await db.getPool();
    if (!await riskTableExists(p, res)) {
      return res.status(404).json({ error: 'Risk scores not available' });
    }

    const request = timedRequest(p, 'risk-score-single', res);
    request.input('id', id);
    request.input('entityType', entityType);
    const result = await request.query(`
      SELECT rs.*
      FROM "RiskScores" rs
      WHERE rs."entityId" = @id AND rs."entityType" = @entityType
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Risk score not found for this entity' });
    }

    const riskData = parseJsonColumns(result.recordset[0]);

    // Fetch entity display name
    let displayName = null;
    const entityTableMap = {
      Principal: 'Principals',
      Resource: 'Resources',
      BusinessRole: 'Resources',
      Context: 'Contexts',
      Identity: 'Identities',
    };
    const tableName = entityTableMap[entityType];
    if (tableName) {
      try {
        const ent = await timedRequest(p, 'risk-score-entity-name', res)
          .input('id', id)
          .query(`SELECT "displayName" FROM [${"tableName"}] WHERE id = @id AND ${TEMPORAL_FILTER}`);
        displayName = ent.recordset[0]?.displayName || null;
      } catch { /* entity table may not exist */ }
    }

    return res.json({ ...riskData, displayName });
  } catch (err) {
    console.error('Risk score lookup failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk score' });
  }
});

// ─── PUT /api/risk-scores/:type/:id/override ─────────────────────────
// Set an analyst override on a risk score.
// Body: { adjustment: number (-50 to +50), reason: string (required) }
router.put('/risk-scores/:type/:id/override', writeRisk, async (req, res) => {
  try {
    const parsed = parseEntityParams(req, res);
    if (!parsed) return;
    const { id, entityType } = parsed;

    const { adjustment, reason } = req.body || {};
    if (typeof adjustment !== 'number' || adjustment < -50 || adjustment > 50 || !Number.isInteger(adjustment)) {
      return res.status(400).json({ error: 'Adjustment must be an integer between -50 and +50' });
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      return res.status(400).json({ error: 'Reason is required (minimum 3 characters)' });
    }
    if (reason.length > 500) {
      return res.status(400).json({ error: 'Reason must be 500 characters or fewer' });
    }

    const assignedBy = req.user?.preferred_username || req.user?.name || 'Unknown';
    const p = await db.getPool();
    if (!await riskTableExists(p, res)) {
      return res.status(404).json({ error: 'Risk scores not available' });
    }

    const recomputed = await recomputeScore(p, res, id, entityType, adjustment);
    if (!recomputed) return;
    const { newScore, newTier } = recomputed;

    // Update RiskScores table
    await timedRequest(p, 'risk-override-set', res)
      .input('id', id)
      .input('entityType', entityType)
      .input('adjustment', adjustment)
      .input('reason', reason.trim())
      .input('newScore', newScore)
      .input('newTier', newTier)
      .query(`
        UPDATE "RiskScores"
        SET "riskOverride" = @adjustment,
            "riskOverrideReason" = @reason,
            "riskScore" = @newScore,
            "riskTier" = @newTier
        WHERE "entityId" = @id AND "entityType" = @entityType
      `);

    await denormalizeScore(p, res, id, entityType, newScore, newTier);

    return res.json({ success: true, adjustment, reason: reason.trim(), riskScore: newScore, riskTier: newTier, assignedBy });
  } catch (err) {
    console.error('Risk override set failed:', err.message);
    return res.status(500).json({ error: 'Failed to set override' });
  }
});

// ─── DELETE /api/risk-scores/:type/:id/override ──────────────────────
// Remove an analyst override from an entity.
router.delete('/risk-scores/:type/:id/override', writeRisk, async (req, res) => {
  try {
    const parsed = parseEntityParams(req, res);
    if (!parsed) return;
    const { id, entityType } = parsed;

    const p = await db.getPool();
    if (!await riskTableExists(p, res)) {
      return res.status(404).json({ error: 'Risk scores not available' });
    }

    const recomputed = await recomputeScore(p, res, id, entityType);
    if (!recomputed) return;
    const { newScore, newTier } = recomputed;

    // Clear override in RiskScores table
    await timedRequest(p, 'risk-override-clear', res)
      .input('id', id)
      .input('entityType', entityType)
      .input('newScore', newScore)
      .input('newTier', newTier)
      .query(`
        UPDATE "RiskScores"
        SET "riskOverride" = 0,
            "riskOverrideReason" = NULL,
            "riskScore" = @newScore,
            "riskTier" = @newTier
        WHERE "entityId" = @id AND "entityType" = @entityType
      `);

    await denormalizeScore(p, res, id, entityType, newScore, newTier);

    return res.json({ success: true, riskScore: newScore, riskTier: newTier });
  } catch (err) {
    console.error('Risk override clear failed:', err.message);
    return res.status(500).json({ error: 'Failed to clear override' });
  }
});


export default router;
