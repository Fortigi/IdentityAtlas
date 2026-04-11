// ─── Resource Clusters API Routes ──────────────────────────────────────
//
// Reads pre-computed resource clusters from SQL.
// Clusters are computed by Save-FGResourceClusters (called from Invoke-FGRiskScoring).
// This route reads cluster data and manages owner assignments.
//
// GET    /api/risk-scores/clusters              - List all clusters with summary
// GET    /api/risk-scores/clusters/:id          - Single cluster with members
// PUT    /api/risk-scores/clusters/:id/owner    - Assign owner to cluster
// DELETE /api/risk-scores/clusters/:id/owner    - Remove owner from cluster

import { Router } from 'express';
import { timedRequest } from '../perf/sqlTimer.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

async function hasTable(pool, tableName) {
  const result = await pool.request()
    .input('tableName', tableName)
    .query(`SELECT to_regclass('public.' || '"' || @tableName || '"') AS t`);
  return !!result.recordset[0].t;
}

// GET /api/risk-scores/clusters — list all clusters
router.get('/risk-scores/clusters', async (req, res) => {
  if (!useSql) return res.json({ available: false, data: [], total: 0 });

  try {
    const p = await db.getPool();

    if (!(await hasTable(p, 'GraphResourceClusters'))) {
      return res.json({ available: false, data: [], total: 0 });
    }

    const { tier, search, sort, limit, offset } = req.query;
    const pageLimit = Math.min(parseInt(limit) || 50, 200);
    const pageOffset = parseInt(offset) || 0;

    let where = 'WHERE "memberCount" > 0';
    const inputs = {};

    if (tier) {
      where += ' AND "riskTier" = @tier';
      inputs.tier = tier;
    }
    if (search) {
      where += ' AND ("displayName" ILIKE @search OR "description" ILIKE @search OR "sourceClassifierId" ILIKE @search)';
      inputs.search = `%${search}%`;
    }

    const sortOptions = {
      name: '"displayName" ASC',
      'name-desc': '"displayName" DESC',
      type: '"clusterType" ASC',
      'type-desc': '"clusterType" DESC',
      members: '"memberCount" DESC',
      'members-asc': '"memberCount" ASC',
      score: '"aggregateRiskScore" DESC',
      'score-asc': '"aggregateRiskScore" ASC',
      tier: '"aggregateRiskScore" DESC',
      'tier-asc': '"aggregateRiskScore" ASC',
      owner: '"ownerDisplayName" ASC',
      'owner-desc': '"ownerDisplayName" DESC',
    };
    let orderBy = `ORDER BY ${sortOptions[sort] || '"aggregateRiskScore" DESC'}`;

    // Count total
    const countReq = timedRequest(p, 'cluster-count', res);
    for (const [k, v] of Object.entries(inputs)) countReq.input(k, v);
    const countResult = await countReq.query(`SELECT COUNT(*) AS total FROM "GraphResourceClusters" ${where}`);
    const total = countResult.recordset[0].total;

    // Fetch page
    const dataReq = timedRequest(p, 'cluster-list', res);
    for (const [k, v] of Object.entries(inputs)) dataReq.input(k, v);
    dataReq.input('limit', pageLimit);
    dataReq.input('offset', pageOffset);

    const dataResult = await dataReq.query(`
      SELECT "id", "displayName", "description", "clusterType", "sourceClassifierId", "sourceClassifierCategory",
             "matchPatterns", "memberCount", "memberCountProd", "memberCountNonProd",
             "aggregateRiskScore", "maxMemberRiskScore", "avgMemberRiskScore",
             "riskTier", "tierDistribution",
             "ownerUserId", "ownerDisplayName", "ownerAssignedAt", "ownerAssignedBy", "scoredAt"
      FROM "GraphResourceClusters"
      ${where}
      ${orderBy}
      LIMIT @limit OFFSET @offset
    `);

    const data = dataResult.recordset.map(row => {
      const r = { ...row };
      try { r.tierDistribution = r.tierDistribution ? JSON.parse(r.tierDistribution) : {}; }
      catch { r.tierDistribution = {}; }
      try { r.matchPatterns = r.matchPatterns ? JSON.parse(r.matchPatterns) : []; }
      catch { r.matchPatterns = []; }
      return r;
    });

    res.json({ available: true, data, total });
  } catch (err) {
    console.error('Error fetching clusters:', err.message);
    res.status(500).json({ error: 'Failed to fetch clusters' });
  }
});

// GET /api/risk-scores/clusters/:id — single cluster with members
router.get('/risk-scores/clusters/:id', async (req, res) => {
  if (!useSql) return res.status(404).json({ error: 'SQL not configured' });

  try {
    const p = await db.getPool();
    const clusterId = req.params.id;

    if (!(await hasTable(p, 'GraphResourceClusters'))) {
      return res.status(404).json({ error: 'Cluster tables not found' });
    }

    // Fetch cluster
    const clusterResult = await timedRequest(p, 'cluster-detail', res)
      .input('id', clusterId)
      .query('SELECT * FROM "GraphResourceClusters" WHERE "id" = @id');

    if (clusterResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Cluster not found' });
    }

    const cluster = { ...clusterResult.recordset[0] };
    try { cluster.tierDistribution = cluster.tierDistribution ? JSON.parse(cluster.tierDistribution) : {}; }
    catch { cluster.tierDistribution = {}; }
    try { cluster.matchPatterns = cluster.matchPatterns ? JSON.parse(cluster.matchPatterns) : []; }
    catch { cluster.matchPatterns = []; }

    // Fetch members
    let members = [];
    if (await hasTable(p, 'GraphResourceClusterMembers')) {
      const memberResult = await timedRequest(p, 'cluster-members', res)
        .input('clusterId', clusterId)
        .query('SELECT * FROM "GraphResourceClusterMembers" WHERE "clusterId" = @clusterId ORDER BY "resourceRiskScore" DESC');
      members = memberResult.recordset;
    }

    res.json({ cluster, members });
  } catch (err) {
    console.error('Error fetching cluster detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch cluster detail' });
  }
});

// PUT /api/risk-scores/clusters/:id/owner — assign owner
router.put('/risk-scores/clusters/:id/owner', async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL not configured' });

  try {
    const p = await db.getPool();
    const clusterId = req.params.id;
    const { userId, displayName } = req.body;

    if (!displayName) {
      return res.status(400).json({ error: 'displayName is required' });
    }

    // Derive assignedBy from authenticated user, not request body
    const assignedBy = req.user?.preferred_username || req.user?.name || 'Unknown';

    const result = await timedRequest(p, 'cluster-assign-owner', res)
      .input('id', clusterId)
      .input('ownerUserId', userId || null)
      .input('ownerDisplayName', displayName)
      .input('ownerAssignedBy', assignedBy)
      .query(`
        UPDATE "GraphResourceClusters"
        SET "ownerUserId" = @ownerUserId,
            "ownerDisplayName" = @ownerDisplayName,
            "ownerAssignedAt" = now() AT TIME ZONE 'utc',
            "ownerAssignedBy" = @ownerAssignedBy
        WHERE "id" = @id
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Cluster not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error assigning cluster owner:', err.message);
    res.status(500).json({ error: 'Failed to assign owner' });
  }
});

// DELETE /api/risk-scores/clusters/:id/owner — remove owner
router.delete('/risk-scores/clusters/:id/owner', async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL not configured' });

  try {
    const p = await db.getPool();
    const clusterId = req.params.id;

    const result = await timedRequest(p, 'cluster-remove-owner', res)
      .input('id', clusterId)
      .query(`
        UPDATE "GraphResourceClusters"
        SET "ownerUserId" = NULL,
            "ownerDisplayName" = NULL,
            "ownerAssignedAt" = NULL,
            "ownerAssignedBy" = NULL
        WHERE "id" = @id
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Cluster not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing cluster owner:', err.message);
    res.status(500).json({ error: 'Failed to remove owner' });
  }
});

// GET /api/risk-scores/clusters/summary — cluster statistics for dashboard
router.get('/risk-scores/cluster-summary', async (req, res) => {
  if (!useSql) return res.json({ available: false });

  try {
    const p = await db.getPool();

    if (!(await hasTable(p, 'GraphResourceClusters'))) {
      return res.json({ available: false });
    }

    const stats = await timedRequest(p, 'cluster-summary', res).query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN "ownerUserId" IS NULL THEN 1 ELSE 0 END) AS unowned,
        MAX("scoredAt") AS "lastScoredAt"
      FROM "GraphResourceClusters"
      WHERE "memberCount" > 0
    `);

    const tiers = await timedRequest(p, 'cluster-tiers', res).query(`
      SELECT "riskTier", COUNT(*) AS count
      FROM "GraphResourceClusters"
      WHERE "memberCount" > 0
      GROUP BY "riskTier"
    `);

    const s = stats.recordset[0];
    res.json({
      available: true,
      total: s.total,
      unowned: s.unowned,
      lastScoredAt: s.lastScoredAt,
      byTier: Object.fromEntries(tiers.recordset.map(r => [r.riskTier, r.count])),
    });
  } catch (err) {
    console.error('Error fetching cluster summary:', err.message);
    res.status(500).json({ error: 'Failed to fetch cluster summary' });
  }
});

export default router;
