// Risk-score list endpoints — GET /api/risk-scores (summary + top entities) and
// the per-type paginated lists (/users, /groups, /business-roles, /contexts, /identities).
//
// Extracted verbatim from routes/riskScores.js (audit finding C1). Mounted by
// routes/riskScores.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import { timedRequest } from '../../perf/sqlTimer.js';
import { queryRiskScoresPage } from '../../db/queryHelpers.js';
import { useSql, db, riskTableExists, parseJsonColumns, TEMPORAL_FILTER } from './shared.js';

const router = Router();

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
      SELECT rs.*, p."displayName", p.email AS "userPrincipalName", p.department
      FROM "RiskScores" rs
      INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}
      WHERE rs."entityType" = 'Principal'
      ORDER BY rs."riskScore" DESC
      LIMIT 10
    `);

    // Top 10 resources by score
    const topResources = await timedRequest(p, 'risk-top-resources', res).query(`
      SELECT rs.*, r."displayName", r."resourceType", r.description
      FROM "RiskScores" rs
      INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}
      WHERE rs."entityType" = 'Resource'
      ORDER BY rs."riskScore" DESC
      LIMIT 10
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
      LIMIT 1
    `);

    // Resource type breakdown
    let resourceTypeBreakdown = null;
    try {
      const typeResult = await timedRequest(p, 'risk-resource-types', res).query(`
        SELECT r."resourceType", COUNT(*) AS count, AVG(CAST(rs."riskScore" AS FLOAT)) AS "avgScore"
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

    const limit  = Math.min(parseInt(req.query.limit,  10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier         = req.query.tier || '';
    const search       = req.query.search || '';
    const department   = req.query.department || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'Principal'`;
    const params = [];
    if (tier)        { whereClause += ' AND rs."riskTier" = @tier';                                                                                 params.push({ name: 'tier',       value: tier }); }
    if (search)      { whereClause += ' AND (p."displayName" ILIKE @search OR p.email ILIKE @search OR p.department ILIKE @search)';                params.push({ name: 'search',     value: `%${search}%` }); }
    if (department)  { whereClause += ' AND p.department = @department';                                                                            params.push({ name: 'department', value: department }); }
    if (overridesOnly) whereClause += ' AND rs."riskOverride" IS NOT NULL';

    const { data, total } = await queryRiskScoresPage(p, res, {
      label:      'risk-users',
      fromClause: `INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}`,
      selectCols: `p."displayName", p.email AS "userPrincipalName", p.department, p."jobTitle", p."companyName"`,
      whereClause, params, limit, offset,
    });
    return res.json({ data: data.map(parseJsonColumns), total, available: true });
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

    const limit  = Math.min(parseInt(req.query.limit,  10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier          = req.query.tier || '';
    const search        = req.query.search || '';
    const resourceType  = req.query.resourceType || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'Resource'`;
    const params = [];
    if (tier)          { whereClause += ' AND rs."riskTier" = @tier';                                              params.push({ name: 'tier',          value: tier }); }
    if (search)        { whereClause += ' AND (r."displayName" ILIKE @search OR r.description ILIKE @search)';    params.push({ name: 'search',        value: `%${search}%` }); }
    if (resourceType)  { whereClause += ' AND r.resourceType = @resourceType';                                     params.push({ name: 'resourceType',  value: resourceType }); }
    if (overridesOnly) whereClause += ' AND rs."riskOverride" IS NOT NULL';

    const { data, total } = await queryRiskScoresPage(p, res, {
      label:      'risk-groups',
      fromClause: `INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}`,
      selectCols: `r."displayName", r.description, r."resourceType", r.mail`,
      whereClause, params, limit, offset,
    });
    return res.json({ data: data.map(parseJsonColumns), total, available: true, useResources: true });
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

    const limit  = Math.min(parseInt(req.query.limit,  10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier          = req.query.tier || '';
    const search        = req.query.search || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'BusinessRole'`;
    const params = [];
    if (tier)        { whereClause += ' AND rs."riskTier" = @tier';                                                params.push({ name: 'tier',    value: tier }); }
    if (search)      { whereClause += ' AND (br."displayName" ILIKE @search OR br.description ILIKE @search)';    params.push({ name: 'search',  value: `%${search}%` }); }
    if (overridesOnly) whereClause += ' AND rs."riskOverride" IS NOT NULL';

    const { data, total } = await queryRiskScoresPage(p, res, {
      label:      'risk-business-roles',
      fromClause: `INNER JOIN "Resources" br ON rs."entityId" = br.id AND br."resourceType" = 'BusinessRole' AND ${TEMPORAL_FILTER}
      LEFT JOIN "GovernanceCatalogs" c ON br."catalogId" = c.id AND ${TEMPORAL_FILTER}`,
      selectCols: `br."displayName", br.description, br."catalogId", c."displayName" AS "catalogName"`,
      whereClause, params, limit, offset,
    });
    return res.json({ data: data.map(parseJsonColumns), total, available: true });
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

    const limit  = Math.min(parseInt(req.query.limit,  10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier          = req.query.tier || '';
    const search        = req.query.search || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'Context'`;
    const params = [];
    if (tier)        { whereClause += ' AND rs."riskTier" = @tier';                                                    params.push({ name: 'tier',   value: tier }); }
    if (search)      { whereClause += ' AND (ou."displayName" ILIKE @search OR ou.department ILIKE @search)';          params.push({ name: 'search', value: `%${search}%` }); }
    if (overridesOnly) whereClause += ' AND rs."riskOverride" IS NOT NULL';

    const { data, total } = await queryRiskScoresPage(p, res, {
      label:      'risk-contexts',
      fromClause: `INNER JOIN "Contexts" ou ON rs."entityId" = ou.id AND ${TEMPORAL_FILTER}
      LEFT JOIN "Principals" p ON ou."managerId" = p.id AND ${TEMPORAL_FILTER}`,
      selectCols: `ou."displayName", ou.department, ou."memberCount", ou."managerId", p."displayName" AS "managerName"`,
      whereClause, params, limit, offset,
    });
    return res.json({ data: data.map(parseJsonColumns), total, available: true });
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

    const limit  = Math.min(parseInt(req.query.limit,  10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tier          = req.query.tier || '';
    const search        = req.query.search || '';
    const overridesOnly = req.query.overridesOnly === 'true';

    let whereClause = `WHERE rs."entityType" = 'Identity'`;
    const params = [];
    if (tier)        { whereClause += ' AND rs."riskTier" = @tier';                                                                             params.push({ name: 'tier',   value: tier }); }
    if (search)      { whereClause += ' AND (i."displayName" ILIKE @search OR i.department ILIKE @search OR i.email ILIKE @search)';            params.push({ name: 'search', value: `%${search}%` }); }
    if (overridesOnly) whereClause += ' AND rs."riskOverride" IS NOT NULL';

    const { data, total } = await queryRiskScoresPage(p, res, {
      label:      'risk-identities',
      fromClause: `INNER JOIN "Identities" i ON rs."entityId" = i.id AND ${TEMPORAL_FILTER}`,
      selectCols: `i."displayName", i."accountCount", i."linkConfidence", i.department, i."jobTitle", i.email`,
      whereClause, params, limit, offset,
    });
    return res.json({ data: data.map(parseJsonColumns), total, available: true });
  } catch (err) {
    console.error('Risk identities query failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk scores' });
  }
});


export default router;
