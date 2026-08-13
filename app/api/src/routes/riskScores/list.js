// Risk-score list endpoints — GET /api/risk-scores (summary + top entities) and
// the per-type paginated lists (/users, /groups, /business-roles, /contexts, /identities).
//
// Extracted verbatim from routes/riskScores.js (audit finding C1). Mounted by
// routes/riskScores.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import { createParams } from '../../db/sqlParams.js';
import { queryRiskScoresPage } from '../../db/queryHelpers.js';
import { useSql, db, riskTableExists, parseJsonColumns, TEMPORAL_FILTER } from './shared.js';
import { fetchRiskOverview, buildRiskSummary } from './summary.js';

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

    const overview = await fetchRiskOverview(p, res);
    return res.json({
      available: true,
      useResources: true,
      summary: buildRiskSummary(overview),
      scoredAt: overview.scoredAt,
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

      const { params, bind } = createParams();
      let whereClause = `WHERE rs."entityType" = '${entityType}'`;
      if (tier)   whereClause += ` AND rs."riskTier" = ${bind(tier)}`;
      if (search) whereClause += ` AND ${searchColumns(bind(`%${search}%`))}`;
      if (extraFilter) {
        const value = req.query[extraFilter.name] || '';
        if (value) whereClause += ` AND ${extraFilter.clause(bind(value))}`;
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

// searchColumns / extraFilter.clause are functions of the bound placeholder(s)
// so defineListRoute can bind the value once (via createParams) and splice in
// the resulting $N — the search term may appear in several columns.
const RISK_LIST_TYPES = [
  {
    name: 'users',
    entityType: 'Principal',
    fromClause: `INNER JOIN "Principals" p ON rs."entityId" = p.id AND ${TEMPORAL_FILTER}`,
    selectCols: `p."displayName", p.email AS "userPrincipalName", p.department, p."jobTitle", p."companyName"`,
    searchColumns: (s) => `(p."displayName" ILIKE ${s} OR p.email ILIKE ${s} OR p.department ILIKE ${s})`,
    extraFilter: { name: 'department', clause: (ph) => `p.department = ${ph}` },
  },
  {
    name: 'groups',
    entityType: 'Resource',
    fromClause: `INNER JOIN "Resources" r ON rs."entityId" = r.id AND ${TEMPORAL_FILTER}`,
    selectCols: `r."displayName", r.description, r."resourceType", r.mail`,
    searchColumns: (s) => `(r."displayName" ILIKE ${s} OR r.description ILIKE ${s})`,
    extraFilter: { name: 'resourceType', clause: (ph) => `r.resourceType = ${ph}` },
    responseExtra: { useResources: true },
  },
  {
    name: 'business-roles',
    entityType: 'BusinessRole',
    fromClause: `INNER JOIN "Resources" br ON rs."entityId" = br.id AND br."resourceType" = 'BusinessRole' AND ${TEMPORAL_FILTER}
      LEFT JOIN "GovernanceCatalogs" c ON br."catalogId" = c.id AND ${TEMPORAL_FILTER}`,
    selectCols: `br."displayName", br.description, br."catalogId", c."displayName" AS "catalogName"`,
    searchColumns: (s) => `(br."displayName" ILIKE ${s} OR br.description ILIKE ${s})`,
  },
  {
    name: 'contexts',
    entityType: 'Context',
    fromClause: `INNER JOIN "Contexts" ou ON rs."entityId" = ou.id AND ${TEMPORAL_FILTER}
      LEFT JOIN "Principals" p ON ou."managerId" = p.id AND ${TEMPORAL_FILTER}`,
    selectCols: `ou."displayName", ou.department, ou."memberCount", ou."managerId", p."displayName" AS "managerName"`,
    searchColumns: (s) => `(ou."displayName" ILIKE ${s} OR ou.department ILIKE ${s})`,
  },
  {
    name: 'identities',
    entityType: 'Identity',
    fromClause: `INNER JOIN "Identities" i ON rs."entityId" = i.id AND ${TEMPORAL_FILTER}`,
    selectCols: `i."displayName", i."accountCount", i."linkConfidence", i.department, i."jobTitle", i.email`,
    searchColumns: (s) => `(i."displayName" ILIKE ${s} OR i.department ILIKE ${s} OR i.email ILIKE ${s})`,
  },
];

for (const type of RISK_LIST_TYPES) defineListRoute(type);


export default router;
