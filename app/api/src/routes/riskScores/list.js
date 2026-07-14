// Risk-score list endpoints — GET /api/risk-scores (summary + top entities) and
// the per-type paginated lists (/users, /groups, /business-roles, /contexts, /identities).
//
// Extracted verbatim from routes/riskScores.js (audit finding C1). Mounted by
// routes/riskScores.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import { timedQuery } from '../../perf/sqlTimer.js';
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
    const tierResult = await timedQuery(p, 'risk-tier-distribution', res, `
      SELECT "entityType", "riskTier", COUNT(*) AS count
      FROM "RiskScores"
      GROUP BY "entityType", "riskTier"
    `, []);

    // Top 10 principals by score
    const topUsers = await timedQuery(p, 'risk-top-users', res, `
      SELECT rs.*, p."displayName", p.email AS "userPrincipalName", p.department
      FROM "RiskScores" rs
      INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}
      WHERE rs."entityType" = 'Principal'
      ORDER BY rs."riskScore" DESC
      LIMIT 10
    `, []);

    // Top 10 resources by score
    const topResources = await timedQuery(p, 'risk-top-resources', res, `
      SELECT rs.*, r."displayName", r."resourceType", r.description
      FROM "RiskScores" rs
      INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}
      WHERE rs."entityType" = 'Resource'
      ORDER BY rs."riskScore" DESC
      LIMIT 10
    `, []);

    // Totals and override counts
    const totals = await timedQuery(p, 'risk-totals', res, `
      SELECT
        "entityType",
        COUNT(*) AS total,
        SUM(CASE WHEN "riskOverride" IS NOT NULL THEN 1 ELSE 0 END) AS overrides
      FROM "RiskScores"
      GROUP BY "entityType"
    `, []);

    // Most recent scored-at timestamp
    const tsResult = await timedQuery(p, 'risk-scored-at', res, `
      SELECT "riskScoredAt" FROM "RiskScores"
      WHERE "riskScoredAt" IS NOT NULL
      ORDER BY "riskScoredAt" DESC
      LIMIT 1
    `, []);

    // Resource type breakdown
    let resourceTypeBreakdown = null;
    try {
      const typeResult = await timedQuery(p, 'risk-resource-types', res, `
        SELECT r."resourceType", COUNT(*) AS count, AVG(CAST(rs."riskScore" AS FLOAT)) AS "avgScore"
        FROM "RiskScores" rs
        INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}
        WHERE rs."entityType" = 'Resource'
        GROUP BY r."resourceType"
        ORDER BY AVG(CAST(rs."riskScore" AS FLOAT)) DESC
      `, []);
      resourceTypeBreakdown = typeResult.rows;
    } catch { resourceTypeBreakdown = null; }

    // Build tier summary objects per entity type
    const tiersByEntityType = {};
    for (const row of tierResult.rows) {
      const tier = row.riskTier || 'None';
      if (!tiersByEntityType[row.entityType]) tiersByEntityType[row.entityType] = {};
      tiersByEntityType[row.entityType][tier] = (tiersByEntityType[row.entityType][tier] || 0) + row.count;
    }

    // Build totals lookup
    const totalsByType = {};
    for (const row of totals.rows) totalsByType[row.entityType] = row;

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
        topGroups: topResources.rows.map(parseJsonColumns),
        topUsers: topUsers.rows.map(parseJsonColumns),
        resourceTypeBreakdown,
      },
      scoredAt: tsResult.rows[0]?.riskScoredAt || null,
    });
  } catch (err) {
    console.error('Risk scores summary failed:', err.message);
    return res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

// ─── Per-type paginated lists ─────────────────────────────────────────
// The five /risk-scores/<type> endpoints are structurally identical — same
// availability guards, same limit/offset/tier/search/overridesOnly parsing,
// same queryRiskScoresPage call and error handling. Only the entity table it
// joins, the columns it selects, the search columns, one optional extra filter,
// and the response's `useResources` flag differ. `defineListRoute` captures the
// shared shape; RISK_LIST_TYPES holds the per-type differences.
//
// Every derived string comes from `name`:
//   path  = /risk-scores/<name>   label = risk-<name>   log = "Risk <name> query failed"
function defineListRoute({ name, entityType, fromClause, selectCols, searchColumns, extraFilter = null, responseExtra = {} }) {
  router.get(`/risk-scores/${name}`, async (req, res) => {
    try {
      if (!useSql) return res.json({ data: [], total: 0, available: false });
      const p = await db.getPool();
      if (!await riskTableExists(p, res)) return res.json({ data: [], total: 0, available: false });

      const limit  = Math.min(parseInt(req.query.limit,  10) || 100, 500);
      const offset = parseInt(req.query.offset, 10) || 0;
      const tier          = req.query.tier || '';
      const search        = req.query.search || '';
      const overridesOnly = req.query.overridesOnly === 'true';

      let whereClause = `WHERE rs."entityType" = '${entityType}'`;
      const params = [];
      if (tier)   { whereClause += ' AND rs."riskTier" = @tier';  params.push({ name: 'tier',   value: tier }); }
      if (search) { whereClause += ` AND ${searchColumns}`;       params.push({ name: 'search', value: `%${search}%` }); }
      if (extraFilter) {
        const value = req.query[extraFilter.name] || '';
        if (value) { whereClause += ` AND ${extraFilter.clause}`; params.push({ name: extraFilter.name, value }); }
      }
      if (overridesOnly) whereClause += ' AND rs."riskOverride" IS NOT NULL';

      const { data, total } = await queryRiskScoresPage(p, res, {
        label: `risk-${name}`,
        fromClause, selectCols, whereClause, params, limit, offset,
      });
      return res.json({ data: data.map(parseJsonColumns), total, available: true, ...responseExtra });
    } catch (err) {
      console.error(`Risk ${name} query failed:`, err.message);
      return res.status(500).json({ error: 'Failed to load risk scores' });
    }
  });
}

const RISK_LIST_TYPES = [
  {
    name: 'users',
    entityType: 'Principal',
    fromClause: `INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}`,
    selectCols: `p."displayName", p.email AS "userPrincipalName", p.department, p."jobTitle", p."companyName"`,
    searchColumns: '(p."displayName" ILIKE @search OR p.email ILIKE @search OR p.department ILIKE @search)',
    extraFilter: { name: 'department', clause: 'p.department = @department' },
  },
  {
    name: 'groups',
    entityType: 'Resource',
    fromClause: `INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}`,
    selectCols: `r."displayName", r.description, r."resourceType", r.mail`,
    searchColumns: '(r."displayName" ILIKE @search OR r.description ILIKE @search)',
    extraFilter: { name: 'resourceType', clause: 'r.resourceType = @resourceType' },
    responseExtra: { useResources: true },
  },
  {
    name: 'business-roles',
    entityType: 'BusinessRole',
    fromClause: `INNER JOIN "Resources" br ON rs."entityId" = br.id AND br."resourceType" = 'BusinessRole' AND ${TEMPORAL_FILTER}
      LEFT JOIN "GovernanceCatalogs" c ON br."catalogId" = c.id AND ${TEMPORAL_FILTER}`,
    selectCols: `br."displayName", br.description, br."catalogId", c."displayName" AS "catalogName"`,
    searchColumns: '(br."displayName" ILIKE @search OR br.description ILIKE @search)',
  },
  {
    name: 'contexts',
    entityType: 'Context',
    fromClause: `INNER JOIN "Contexts" ou ON rs."entityId" = ou.id AND ${TEMPORAL_FILTER}
      LEFT JOIN "Principals" p ON ou."managerId" = p.id AND ${TEMPORAL_FILTER}`,
    selectCols: `ou."displayName", ou.department, ou."memberCount", ou."managerId", p."displayName" AS "managerName"`,
    searchColumns: '(ou."displayName" ILIKE @search OR ou.department ILIKE @search)',
  },
  {
    name: 'identities',
    entityType: 'Identity',
    fromClause: `INNER JOIN "Identities" i ON rs."entityId" = i.id AND ${TEMPORAL_FILTER}`,
    selectCols: `i."displayName", i."accountCount", i."linkConfidence", i.department, i."jobTitle", i.email`,
    searchColumns: '(i."displayName" ILIKE @search OR i.department ILIKE @search OR i.email ILIKE @search)',
  },
];

for (const type of RISK_LIST_TYPES) defineListRoute(type);


export default router;
