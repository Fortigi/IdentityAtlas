// Data + assembly for GET /api/risk-scores (the summary card), extracted from
// riskScores/list.js to keep the handler under the complexity threshold. The
// `num` helper collapses each per-type `byType[t]?.[k] || 0` into a call (no
// branch). SQL moved verbatim.

import { timedQuery } from '../../perf/sqlTimer.js';
import { parseJsonColumns, TEMPORAL_FILTER } from './shared.js';

// Nested count with a 0 default — a call, so it adds no branch at each use site.
const num = (byType, type, key) => byType[type]?.[key] || 0;

// Run the six aggregate reads that back the summary card.
export async function fetchRiskOverview(p, res) {
  const tierResult = await timedQuery(p, 'risk-tier-distribution', res, `
    SELECT "entityType", "riskTier", COUNT(*) AS count
    FROM "RiskScores"
    GROUP BY "entityType", "riskTier"
  `, []);

  const topUsers = await timedQuery(p, 'risk-top-users', res, `
    SELECT rs.*, p."displayName", p.email AS "userPrincipalName", p.department
    FROM "RiskScores" rs
    INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}
    WHERE rs."entityType" = 'Principal'
    ORDER BY rs."riskScore" DESC
    LIMIT 10
  `, []);

  const topResources = await timedQuery(p, 'risk-top-resources', res, `
    SELECT rs.*, r."displayName", r."resourceType", r.description
    FROM "RiskScores" rs
    INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}
    WHERE rs."entityType" = 'Resource'
    ORDER BY rs."riskScore" DESC
    LIMIT 10
  `, []);

  const totals = await timedQuery(p, 'risk-totals', res, `
    SELECT
      "entityType",
      COUNT(*) AS total,
      SUM(CASE WHEN "riskOverride" IS NOT NULL THEN 1 ELSE 0 END) AS overrides
    FROM "RiskScores"
    GROUP BY "entityType"
  `, []);

  const tsResult = await timedQuery(p, 'risk-scored-at', res, `
    SELECT "riskScoredAt" FROM "RiskScores"
    WHERE "riskScoredAt" IS NOT NULL
    ORDER BY "riskScoredAt" DESC
    LIMIT 1
  `, []);

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

  return {
    tierRows: tierResult.rows,
    topUsers: topUsers.rows,
    topResources: topResources.rows,
    totalsRows: totals.rows,
    scoredAt: tsResult.rows[0]?.riskScoredAt || null,
    resourceTypeBreakdown,
  };
}

// Pure: tier counts nested by entity type → { entityType: { tier: count } }.
export function buildTiersByEntityType(tierRows) {
  const tiersByEntityType = {};
  for (const row of tierRows) {
    const tier = row.riskTier || 'None';
    if (!tiersByEntityType[row.entityType]) tiersByEntityType[row.entityType] = {};
    tiersByEntityType[row.entityType][tier] = (tiersByEntityType[row.entityType][tier] || 0) + row.count;
  }
  return tiersByEntityType;
}

// Pure: totals rows keyed by entity type.
export function indexTotalsByType(totalsRows) {
  const totalsByType = {};
  for (const row of totalsRows) totalsByType[row.entityType] = row;
  return totalsByType;
}

// Pure: assemble the summary object from the fetched overview.
export function buildRiskSummary({ tierRows, topUsers, topResources, totalsRows, resourceTypeBreakdown }) {
  const tiersByEntityType = buildTiersByEntityType(tierRows);
  const totalsByType = indexTotalsByType(totalsRows);
  return {
    totalGroups: num(totalsByType, 'Resource', 'total'),
    totalUsers: num(totalsByType, 'Principal', 'total'),
    totalBusinessRoles: num(totalsByType, 'BusinessRole', 'total'),
    totalContexts: num(totalsByType, 'Context', 'total'),
    totalIdentities: num(totalsByType, 'Identity', 'total'),
    groupOverrides: num(totalsByType, 'Resource', 'overrides'),
    userOverrides: num(totalsByType, 'Principal', 'overrides'),
    businessRoleOverrides: num(totalsByType, 'BusinessRole', 'overrides'),
    contextOverrides: num(totalsByType, 'Context', 'overrides'),
    identityOverrides: num(totalsByType, 'Identity', 'overrides'),
    groupsByTier: tiersByEntityType['Resource'] || {},
    usersByTier: tiersByEntityType['Principal'] || {},
    businessRolesByTier: tiersByEntityType['BusinessRole'] || {},
    contextsByTier: tiersByEntityType['Context'] || {},
    identitiesByTier: tiersByEntityType['Identity'] || {},
    topGroups: topResources.map(parseJsonColumns),
    topUsers: topUsers.map(parseJsonColumns),
    resourceTypeBreakdown,
  };
}
