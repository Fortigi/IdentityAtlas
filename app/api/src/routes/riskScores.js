// ─── Risk Scores API Routes ───────────────────────────────────────────
//
// Reads pre-computed risk scores from the dedicated RiskScores table.
// Scores are computed by the PowerShell cmdlet Invoke-FGRiskScoring (batch process).
// This route does NO computation — it's a simple SELECT.
//
// GET    /api/risk-scores                    - Summary + top entities by score
// GET    /api/risk-scores/users              - Paginated user (Principal) risk scores
// GET    /api/risk-scores/groups             - Paginated resource risk scores
// GET    /api/risk-scores/business-roles     - Paginated business role risk scores
// GET    /api/risk-scores/contexts           - Paginated context risk scores
// GET    /api/risk-scores/identities         - Paginated identity risk scores
// GET    /api/risk-scores/:type/:id          - Single entity risk score
// PUT    /api/risk-scores/:type/:id/override - Set analyst override (+/- adjustment)
// DELETE /api/risk-scores/:type/:id/override - Remove analyst override

import { Router } from 'express';
import { timedRequest } from '../perf/sqlTimer.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

// ─── Helpers ──────────────────────────────────────────────────────────

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

// Cached check for RiskScores table existence
let _riskTableExists = null;
let _riskTableCheckedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function riskTableExists(pool, res) {
  const now = Date.now();
  if (_riskTableExists !== null && (now - _riskTableCheckedAt) < CACHE_TTL_MS) {
    return _riskTableExists;
  }
  try {
    const result = await timedRequest(pool, 'risk-table-check', res).query(`
      SELECT to_regclass('"RiskScores"') AS tbl
    `);
    _riskTableExists = result.recordset[0].tbl != null;
  } catch {
    _riskTableExists = false;
  }
  _riskTableCheckedAt = now;
  return _riskTableExists;
}

// Parse JSON columns and compute effective score.
// In v5 these are jsonb columns — pg returns them already-parsed, so we only
// need JSON.parse when the value is a legacy string.
function parseJsonColumns(row) {
  const r = { ...row };
  const cm = r.riskClassifierMatches;
  r.classifierMatches = (cm && typeof cm === 'string')
    ? (() => { try { return JSON.parse(cm); } catch { return []; } })()
    : (cm || []);
  delete r.riskClassifierMatches;

  const exp = r.riskExplanation;
  r.explanation = (exp && typeof exp === 'string')
    ? (() => { try { return JSON.parse(exp); } catch { return null; } })()
    : (exp || null);
  delete r.riskExplanation;

  r.riskOverride = r.riskOverride ?? null;
  r.riskOverrideReason = r.riskOverrideReason ?? null;
  r.effectiveScore = r.riskOverride != null
    ? Math.max(0, Math.min(100, (r.riskScore || 0) + r.riskOverride))
    : r.riskScore;

  return r;
}

// Compute tier label from numeric score
function computeTier(score) {
  if (score >= 80) return 'Critical';
  if (score >= 60) return 'High';
  if (score >= 40) return 'Medium';
  if (score >= 20) return 'Low';
  if (score >= 1)  return 'Minimal';
  return 'None';
}

// In v5 (postgres) temporal tables are gone, so the ValidTo filter is a no-op.
// Constant kept so all the JOIN clauses that reference it still compile.
const TEMPORAL_FILTER = "1=1";

// ─── GET /api/risk-scores ─────────────────────────────────────────────
router.get('/risk-scores', async (req, res) => {
  try {
    if (!useSql) {
      return res.json({ available: false, message: 'Risk scoring requires SQL mode. Run Invoke-FGRiskScoring in PowerShell first.' });
    }

    const p = await db.getPool();
    if (!await riskTableExists(p, res)) {
      return res.json({ available: false, message: 'Risk scores not yet computed. Run Invoke-FGRiskScoring in PowerShell.' });
    }

    // Tier distribution by entity type
    const tierResult = await timedRequest(p, 'risk-tier-distribution', res).query(`
      SELECT "entityType", "riskTier", COUNT(*) AS count
      FROM "RiskScores"
      GROUP BY "entityType", "riskTier"
    `);

    // Top 10 principals by score
    const topUsers = await timedRequest(p, 'risk-top-users', res).query(`
      SELECT rs.*, p."displayName", p.email AS userPrincipalName, p.department
      FROM "RiskScores" rs
      INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}
      WHERE rs."entityType" = 'Principal'
      ORDER BY rs."riskScore" DESC
    `);

    // Top 10 resources by score
    const topResources = await timedRequest(p, 'risk-top-resources', res).query(`
      SELECT rs.*, r."displayName", r."resourceType", r.description
      FROM "RiskScores" rs
      INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}
      WHERE rs."entityType" = 'Resource'
      ORDER BY rs."riskScore" DESC
    `);

    // Totals and override counts
    const totals = await timedRequest(p, 'risk-totals', res).query(`
      SELECT
        "entityType",
        COUNT(*) AS total,
        SUM(CASE WHEN "riskOverride" IS NOT NULL THEN 1 ELSE 0 END) AS overrides
      FROM "RiskScores"
      GROUP BY "entityType"
    `);

    // Most recent scored-at timestamp
    const tsResult = await timedRequest(p, 'risk-scored-at', res).query(`
      SELECT "riskScoredAt" FROM "RiskScores"
      WHERE "riskScoredAt" IS NOT NULL
      ORDER BY "riskScoredAt" DESC
    `);

    // Resource type breakdown
    let resourceTypeBreakdown = null;
    try {
      const typeResult = await timedRequest(p, 'risk-resource-types', res).query(`
        SELECT r."resourceType", COUNT(*) AS count, AVG(CAST(rs."riskScore" AS FLOAT)) AS avgScore
        FROM "RiskScores" rs
        INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}
        WHERE rs."entityType" = 'Resource'
        GROUP BY r."resourceType"
        ORDER BY AVG(CAST(rs."riskScore" AS FLOAT)) DESC
      `);
      resourceTypeBreakdown = typeResult.recordset;
    } catch { resourceTypeBreakdown = null; }

    // Build tier summary objects per entity type
    const tiersByEntityType = {};
    for (const row of tierResult.recordset) {
      const tier = row.riskTier || 'None';
      if (!tiersByEntityType[row.entityType]) tiersByEntityType[row.entityType] = {};
      tiersByEntityType[row.entityType][tier] = (tiersByEntityType[row.entityType][tier] || 0) + row.count;
    }

    // Build totals lookup
    const totalsByType = {};
    for (const row of totals.recordset) totalsByType[row.entityType] = row;

    return res.json({
      available: true,
      useResources: true,
      summary: {
        totalGroups: totalsByType['Resource']?.total || 0,
        totalUsers: totalsByType['Principal']?.total || 0,
        totalBusinessRoles: totalsByType['BusinessRole']?.total || 0,
        totalContexts: totalsByType['Context']?.total || 0,
        totalIdentities: totalsByType['Identity']?.total || 0,
        groupOverrides: totalsByType['Resource']?.overrides || 0,
        userOverrides: totalsByType['Principal']?.overrides || 0,
        businessRoleOverrides: totalsByType['BusinessRole']?.overrides || 0,
        contextOverrides: totalsByType['Context']?.overrides || 0,
        identityOverrides: totalsByType['Identity']?.overrides || 0,
        groupsByTier: tiersByEntityType['Resource'] || {},
        usersByTier: tiersByEntityType['Principal'] || {},
        businessRolesByTier: tiersByEntityType['BusinessRole'] || {},
        contextsByTier: tiersByEntityType['Context'] || {},
        identitiesByTier: tiersByEntityType['Identity'] || {},
        topGroups: topResources.recordset.map(parseJsonColumns),
        topUsers: topUsers.recordset.map(parseJsonColumns),
        resourceTypeBreakdown,
      },
      scoredAt: tsResult.recordset[0]?.riskScoredAt || null,
    });
  } catch (err) {
    console.error('Risk scores summary failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

// ─── GET /api/risk-scores/users ───────────────────────────────────────
router.get('/risk-scores/users', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0, available: false });

    const p = await db.getPool();
    if (!await riskTableExists(p, res)) return res.json({ data: [], total: 0, available: false });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier = req.query.tier || '';
    const search = req.query.search || '';
    const department = req.query.department || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'Principal'`;
    const request = timedRequest(p, 'risk-users-list', res);

    if (tier) {
      whereClause += ' AND rs."riskTier" = @tier';
      request.input('tier', tier);
    }
    if (search) {
      whereClause += ' AND (p.displayName LIKE @search OR p.email LIKE @search OR p.department LIKE @search)';
      request.input('search', `%${search}%`);
    }
    if (department) {
      whereClause += ' AND p.department = @department';
      request.input('department', department);
    }
    if (overridesOnly) {
      whereClause += ' AND rs."riskOverride" IS NOT NULL';
    }

    request.input('offset', offset);
    request.input('limit', limit);
    const result = await request.query(`
      SELECT rs.*, p."displayName", p.email AS userPrincipalName, p.department, p."jobTitle", p."companyName"
      FROM "RiskScores" rs
      INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}
      ${whereClause}
      ORDER BY rs."riskScore" DESC
      LIMIT @limit OFFSET @offset
    `);

    const countReq = timedRequest(p, 'risk-users-count', res);
    if (tier) countReq.input('tier', tier);
    if (search) countReq.input('search', `%${search}%`);
    if (department) countReq.input('department', department);
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS total
      FROM "RiskScores" rs
      INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}
      ${whereClause}
    `);

    return res.json({
      data: result.recordset.map(parseJsonColumns),
      total: countResult.recordset[0].total,
      available: true,
    });
  } catch (err) {
    console.error('Risk users query failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

// ─── GET /api/risk-scores/groups ──────────────────────────────────────
router.get('/risk-scores/groups', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0, available: false });

    const p = await db.getPool();
    if (!await riskTableExists(p, res)) return res.json({ data: [], total: 0, available: false });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier = req.query.tier || '';
    const search = req.query.search || '';
    const resourceType = req.query.resourceType || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'Resource'`;
    const request = timedRequest(p, 'risk-groups-list', res);

    if (tier) {
      whereClause += ' AND rs."riskTier" = @tier';
      request.input('tier', tier);
    }
    if (search) {
      whereClause += ' AND (r.displayName LIKE @search OR r.description LIKE @search)';
      request.input('search', `%${search}%`);
    }
    if (resourceType) {
      whereClause += ' AND r.resourceType = @resourceType';
      request.input('resourceType', resourceType);
    }
    if (overridesOnly) {
      whereClause += ' AND rs."riskOverride" IS NOT NULL';
    }

    request.input('offset', offset);
    request.input('limit', limit);
    const result = await request.query(`
      SELECT rs.*, r."displayName", r.description, r."resourceType", r.mail
      FROM "RiskScores" rs
      INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}
      ${whereClause}
      ORDER BY rs."riskScore" DESC
      LIMIT @limit OFFSET @offset
    `);

    const countReq = timedRequest(p, 'risk-groups-count', res);
    if (tier) countReq.input('tier', tier);
    if (search) countReq.input('search', `%${search}%`);
    if (resourceType) countReq.input('resourceType', resourceType);
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS total
      FROM "RiskScores" rs
      INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}
      ${whereClause}
    `);

    return res.json({
      data: result.recordset.map(parseJsonColumns),
      total: countResult.recordset[0].total,
      available: true,
      useResources: true,
    });
  } catch (err) {
    console.error('Risk groups query failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

// ─── GET /api/risk-scores/business-roles ─────────────────────────────
router.get('/risk-scores/business-roles', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0, available: false });

    const p = await db.getPool();
    if (!await riskTableExists(p, res)) return res.json({ data: [], total: 0, available: false });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier = req.query.tier || '';
    const search = req.query.search || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'BusinessRole'`;
    const request = timedRequest(p, 'risk-business-roles-list', res);

    if (tier) {
      whereClause += ' AND rs."riskTier" = @tier';
      request.input('tier', tier);
    }
    if (search) {
      whereClause += ' AND (br.displayName LIKE @search OR br.description LIKE @search)';
      request.input('search', `%${search}%`);
    }
    if (overridesOnly) {
      whereClause += ' AND rs."riskOverride" IS NOT NULL';
    }

    request.input('offset', offset);
    request.input('limit', limit);
    const result = await request.query(`
      SELECT rs.*, br."displayName", br.description, br."catalogId",
             c."displayName" AS catalogName
      FROM "RiskScores" rs
      INNER JOIN "Resources" br ON rs."entityId" = br.id AND br."resourceType" = 'BusinessRole' AND ${TEMPORAL_FILTER}
      LEFT JOIN "GovernanceCatalogs" c ON br."catalogId" = c.id AND ${TEMPORAL_FILTER}
      ${whereClause}
      ORDER BY rs."riskScore" DESC
      LIMIT @limit OFFSET @offset
    `);

    const countReq = timedRequest(p, 'risk-business-roles-count', res);
    if (tier) countReq.input('tier', tier);
    if (search) countReq.input('search', `%${search}%`);
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS total
      FROM "RiskScores" rs
      INNER JOIN "Resources" br ON rs."entityId" = br.id AND br."resourceType" = 'BusinessRole' AND ${TEMPORAL_FILTER}
      LEFT JOIN "GovernanceCatalogs" c ON br."catalogId" = c.id AND ${TEMPORAL_FILTER}
      ${whereClause}
    `);

    return res.json({
      data: result.recordset.map(parseJsonColumns),
      total: countResult.recordset[0].total,
      available: true,
    });
  } catch (err) {
    console.error('Risk business-roles query failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

// ─── GET /api/risk-scores/contexts ──────────────────────────────────
router.get('/risk-scores/contexts', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0, available: false });

    const p = await db.getPool();
    if (!await riskTableExists(p, res)) return res.json({ data: [], total: 0, available: false });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier = req.query.tier || '';
    const search = req.query.search || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'Context'`;
    const request = timedRequest(p, 'risk-contexts-list', res);

    if (tier) {
      whereClause += ' AND rs."riskTier" = @tier';
      request.input('tier', tier);
    }
    if (search) {
      whereClause += ' AND (ou.displayName LIKE @search OR ou.department LIKE @search)';
      request.input('search', `%${search}%`);
    }
    if (overridesOnly) {
      whereClause += ' AND rs."riskOverride" IS NOT NULL';
    }

    request.input('offset', offset);
    request.input('limit', limit);
    const result = await request.query(`
      SELECT rs.*, ou."displayName", ou.department, ou."memberCount", ou."managerId",
             p."displayName" AS managerName
      FROM "RiskScores" rs
      INNER JOIN "Contexts" ou ON rs."entityId" = ou.id AND ${TEMPORAL_FILTER}
      LEFT JOIN "Principals" p ON ou."managerId" = p.id AND ${TEMPORAL_FILTER}
      ${whereClause}
      ORDER BY rs."riskScore" DESC
      LIMIT @limit OFFSET @offset
    `);

    const countReq = timedRequest(p, 'risk-contexts-count', res);
    if (tier) countReq.input('tier', tier);
    if (search) countReq.input('search', `%${search}%`);
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS total
      FROM "RiskScores" rs
      INNER JOIN "Contexts" ou ON rs."entityId" = ou.id AND ${TEMPORAL_FILTER}
      LEFT JOIN "Principals" p ON ou."managerId" = p.id AND ${TEMPORAL_FILTER}
      ${whereClause}
    `);

    return res.json({
      data: result.recordset.map(parseJsonColumns),
      total: countResult.recordset[0].total,
      available: true,
    });
  } catch (err) {
    console.error('Risk contexts query failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

// ─── GET /api/risk-scores/identities ────────────────────────────────
router.get('/risk-scores/identities', async (req, res) => {
  try {
    if (!useSql) return res.json({ data: [], total: 0, available: false });

    const p = await db.getPool();
    if (!await riskTableExists(p, res)) return res.json({ data: [], total: 0, available: false });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier = req.query.tier || '';
    const search = req.query.search || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'Identity'`;
    const request = timedRequest(p, 'risk-identities-list', res);

    if (tier) {
      whereClause += ' AND rs."riskTier" = @tier';
      request.input('tier', tier);
    }
    if (search) {
      whereClause += ' AND (i.displayName LIKE @search OR i.department LIKE @search OR i.email LIKE @search)';
      request.input('search', `%${search}%`);
    }
    if (overridesOnly) {
      whereClause += ' AND rs."riskOverride" IS NOT NULL';
    }

    request.input('offset', offset);
    request.input('limit', limit);
    const result = await request.query(`
      SELECT rs.*, i."displayName", i."accountCount", i."correlationConfidence", i.department,
             i."jobTitle", i.email
      FROM "RiskScores" rs
      INNER JOIN "Identities" i ON rs."entityId" = i.id AND ${TEMPORAL_FILTER}
      ${whereClause}
      ORDER BY rs."riskScore" DESC
      LIMIT @limit OFFSET @offset
    `);

    const countReq = timedRequest(p, 'risk-identities-count', res);
    if (tier) countReq.input('tier', tier);
    if (search) countReq.input('search', `%${search}%`);
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS total
      FROM "RiskScores" rs
      INNER JOIN "Identities" i ON rs."entityId" = i.id AND ${TEMPORAL_FILTER}
      ${whereClause}
    `);

    return res.json({
      data: result.recordset.map(parseJsonColumns),
      total: countResult.recordset[0].total,
      available: true,
    });
  } catch (err) {
    console.error('Risk identities query failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

// ─── GET /api/risk-scores/:type/:id ──────────────────────────────────
router.get('/risk-scores/:type/:id', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

    const { type, id } = req.params;
    if (!VALID_TYPES.has(type)) {
      return res.status(400).json({ error: `Type must be one of: ${[...VALID_TYPES].join(', ')}` });
    }
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid entity ID format' });
    }

    const entityType = mapEntityType(type);
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
router.put('/risk-scores/:type/:id/override', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

    const { type, id } = req.params;
    if (!VALID_TYPES.has(type)) {
      return res.status(400).json({ error: `Type must be one of: ${[...VALID_TYPES].join(', ')}` });
    }
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid entity ID format' });
    }

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

    const entityType = mapEntityType(type);
    const assignedBy = req.user?.preferred_username || req.user?.name || 'Unknown';
    const p = await db.getPool();

    if (!await riskTableExists(p, res)) {
      return res.status(404).json({ error: 'Risk scores not available' });
    }

    // Read current component scores
    const current = await timedRequest(p, 'risk-override-read', res)
      .input('id', id)
      .input('entityType', entityType)
      .query(`
        SELECT "riskDirectScore", "riskMembershipScore", "riskStructuralScore", "riskPropagatedScore"
        FROM "RiskScores"
        WHERE "entityId" = @id AND "entityType" = @entityType
      `);

    if (current.recordset.length === 0) {
      return res.status(404).json({ error: 'Entity not found or not yet scored' });
    }

    const row = current.recordset[0];
    const baseScore = (row.riskDirectScore || 0) + (row.riskMembershipScore || 0)
      + (row.riskStructuralScore || 0) + (row.riskPropagatedScore || 0);
    const newScore = Math.max(0, Math.min(100, baseScore + adjustment));
    const newTier = computeTier(newScore);

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

    // Denormalize to entity table
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

    return res.json({ success: true, adjustment, reason: reason.trim(), riskScore: newScore, riskTier: newTier, assignedBy });
  } catch (err) {
    console.error('Risk override set failed:', err.message);
    return res.status(500).json({ error: 'Failed to set override' });
  }
});

// ─── DELETE /api/risk-scores/:type/:id/override ──────────────────────
// Remove an analyst override from an entity.
router.delete('/risk-scores/:type/:id/override', async (req, res) => {
  try {
    if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

    const { type, id } = req.params;
    if (!VALID_TYPES.has(type)) {
      return res.status(400).json({ error: `Type must be one of: ${[...VALID_TYPES].join(', ')}` });
    }
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid entity ID format' });
    }

    const entityType = mapEntityType(type);
    const p = await db.getPool();

    if (!await riskTableExists(p, res)) {
      return res.status(404).json({ error: 'Risk scores not available' });
    }

    // Read current component scores
    const current = await timedRequest(p, 'risk-override-read', res)
      .input('id', id)
      .input('entityType', entityType)
      .query(`
        SELECT "riskDirectScore", "riskMembershipScore", "riskStructuralScore", "riskPropagatedScore"
        FROM "RiskScores"
        WHERE "entityId" = @id AND "entityType" = @entityType
      `);

    if (current.recordset.length === 0) {
      return res.status(404).json({ error: 'Entity not found or not yet scored' });
    }

    const row = current.recordset[0];
    const newScore = Math.max(0, Math.min(100,
      (row.riskDirectScore || 0) + (row.riskMembershipScore || 0)
      + (row.riskStructuralScore || 0) + (row.riskPropagatedScore || 0)));
    const newTier = computeTier(newScore);

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

    // Denormalize to entity table
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

    return res.json({ success: true, riskScore: newScore, riskTier: newTier });
  } catch (err) {
    console.error('Risk override clear failed:', err.message);
    return res.status(500).json({ error: 'Failed to clear override' });
  }
});

export default router;
