// Sync-log endpoint — /api/sync-log (recent GraphSyncLog entries).
//
// Extracted verbatim from routes/permissions.js (audit finding C1). Mounted by
// routes/permissions.js via router.use(), so the public path is unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { timedQuery } from '../../perf/sqlTimer.js';
import { useSql, db } from './shared.js';

const router = Router();

// Deterministic-shape mock sync-log entries for local dev (no DB).
function generateMockSyncLog(limit) {
  const syncTypes = [
    { type: 'Users', table: 'Principals', records: 1247 },
    { type: 'Groups', table: 'Resources', records: 389 },
    { type: 'GroupMembers', table: 'GraphGroupMembers', records: 4521 },
    { type: 'GroupTransitiveMembers', table: 'GraphGroupTransitiveMembers', records: 8932 },
    { type: 'GroupEligibleMembers', table: 'GraphGroupEligibleMembers', records: 156 },
    { type: 'GroupOwners', table: 'GraphGroupOwners', records: 412 },
    { type: 'Catalogs', table: 'GovernanceCatalogs', records: 12 },
    { type: 'AccessPackages', table: 'Resources (BusinessRole)', records: 67 },
    { type: 'AccessPackageAssignments', table: 'ResourceAssignments (Governed)', records: 834 },
    { type: 'AccessPackageResourceRoleScopes', table: 'ResourceRelationships (Contains)', records: 203 },
    { type: 'AccessPackageAssignmentPolicies', table: 'AssignmentPolicies', records: 71 },
    { type: 'AccessPackageAssignmentRequests', table: 'AssignmentRequests', records: 2103 },
    { type: 'AccessPackageAccessReviews', table: 'CertificationDecisions', records: 45 },
    { type: 'MaterializedViews', table: 'mat_UserPermissionAssignments', records: 0 },
    { type: 'RiskScoring', table: 'Principals,Resources', records: 1636 },
  ];
  const mockLogs = [];
  let id = 1;
  // Generate 2 full sync runs
  for (let run = 0; run < 2; run++) {
    const baseTime = new Date(Date.now() - (run * 24 * 60 * 60 * 1000) - (2 * 60 * 60 * 1000));
    let offset = 0;
    for (const st of syncTypes) {
      const duration = Math.floor(Math.random() * 120) + 5;
      const start = new Date(baseTime.getTime() + offset * 1000);
      const end = new Date(start.getTime() + duration * 1000);
      const isFailed = run === 1 && st.type === 'AccessPackageAccessReviews';
      mockLogs.push({
        Id: id++,
        SyncType: st.type,
        StartTime: start.toISOString(),
        EndTime: end.toISOString(),
        DurationSeconds: duration,
        RecordCount: isFailed ? 0 : st.records + Math.floor(Math.random() * 20),
        Status: isFailed ? 'Failed' : 'Success',
        ErrorMessage: isFailed ? 'The remote server returned an error: (403) Forbidden.' : null,
        TableName: st.table,
        CreatedAt: end.toISOString(),
      });
      offset += duration + 2;
    }
  }
  mockLogs.sort((a, b) => new Date(b.StartTime) - new Date(a.StartTime));
  return mockLogs.slice(0, limit);
}

// GET /api/sync-log - Recent sync log entries from GraphSyncLog
router.get('/sync-log', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

    if (useSql) {
      const p = await db.getPool();
      // Check if GraphSyncLog table exists before querying
      const tableCheck = await timedQuery(p, 'sync-log-check', res, `
        SELECT to_regclass('"GraphSyncLog"') AS "tableExists"
      `, []);
      if (!tableCheck.rows[0].tableExists) {
        return res.json([]);
      }

      const result = await timedQuery(p, 'sync-log-data', res, `
        SELECT "Id", "SyncType", "StartTime", "EndTime", "DurationSeconds",
               "RecordCount", "Status", "ErrorMessage", "TableName", "CreatedAt"
          FROM "GraphSyncLog"
         ORDER BY "StartTime" DESC
         LIMIT $1
      `, [limit]);
      return res.json(result.rows);
    }

    // Mock data path (local dev)
    res.json(generateMockSyncLog(limit));
  } catch (err) {
    console.error('sync-log query failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
