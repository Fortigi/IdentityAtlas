// ─── Account Correlation / Identities API Routes ─────────────────────────
//
// Reads pre-computed identity correlations from SQL.
// Identities are computed by Invoke-FGAccountCorrelation (PowerShell).
// This route reads identity data and manages analyst overrides.
//
// GET    /api/identities                    - Summary + paginated identity list
// GET    /api/identities/:id                - Single identity with all linked accounts
// PUT    /api/identities/:id/verify         - Mark identity as analyst-verified
// DELETE /api/identities/:id/verify         - Remove analyst verification
// PUT    /api/identities/:id/members/:userId/override - Analyst override on member link
// DELETE /api/identities/:id/members/:userId/override - Remove analyst override

import { Router } from 'express';
import { timedRequest } from '../perf/sqlTimer.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

let db = null;
if (useSql) {
  db = await import('../db/connection.js');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function hasTable(_pool, tableName) {
  const r = await db.queryOne(
    `SELECT to_regclass($1) AS t`,
    [`public."${tableName}"`]
  );
  return !!r?.t;
}

// Tag rows come back from SQL as "id:name:color|id:name:color" strings so
// we don't have to LEFT JOIN + GROUP BY every column. Matches the shape
// used by the Resources endpoint.
function parseTagString(tagString) {
  if (!tagString) return [];
  return tagString.split('|').map(t => {
    const parts = t.split(':');
    return { id: parseInt(parts[0]), name: parts[1], color: parts[2] };
  });
}

// GET /api/identities — summary + paginated list
router.get('/identities', async (req, res) => {
  if (!useSql) return res.json({ available: false, data: [], total: 0, summary: null });

  try {
    const p = await db.getPool();

    if (!(await hasTable(p, 'Identities'))) {
      return res.json({ available: false, data: [], total: 0, summary: null });
    }

    const { search, minAccounts, accountType, confidence, verified, hrAnchored, orphanStatus, sort, limit, offset } = req.query;
    const pageLimit = Math.min(parseInt(limit) || 50, 500);
    const pageOffset = parseInt(offset) || 0;

    // Attribute filters (JSON blob from the useEntityPage filter bar). Accept
    // a `__identityTag` virtual field for tag-name filtering.
    let attrFilters = {};
    if (req.query.filters) {
      try { attrFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
    }
    let identityTagFilter = null;
    if (attrFilters['__identityTag']) {
      identityTagFilter = String(attrFilters['__identityTag']);
      delete attrFilters['__identityTag'];
    }

    // Column-existence check runs first because it determines the shape of
    // the summary query below. It's a tiny catalog lookup — keeping it out
    // of the parallel batch is cheap.
    const colCheck = await p.request().query(`
      SELECT column_name AS "COLUMN_NAME" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Identities' AND column_name IN ('isHrAnchored', 'orphanStatus')
    `);
    const hasHrCols = colCheck.recordset.length >= 2;

    // The three big queries are independent — run them in parallel so
    // postgres can schedule them on separate backends.
    const [summaryResult, typeDistResult] = await Promise.all([
      timedRequest(p, 'identity-summary', res).query(`
        SELECT
          COUNT(*) AS "totalIdentities",
          SUM(CASE WHEN "accountCount" > 1 THEN 1 ELSE 0 END) AS "multiAccountIdentities",
          SUM(CASE WHEN "accountCount" = 1 THEN 1 ELSE 0 END) AS "singleAccountIdentities",
          SUM("accountCount") AS "totalAccounts",
          SUM(CASE WHEN "analystVerified" = TRUE THEN 1 ELSE 0 END) AS "verifiedCount",
          AVG(CAST("correlationConfidence" AS FLOAT)) AS "avgConfidence",
          MAX("correlatedAt") AS "lastCorrelatedAt"
          ${hasHrCols ? `, SUM(CASE WHEN "isHrAnchored" = true THEN 1 ELSE 0 END) AS "hrAnchoredCount",
          SUM(CASE WHEN "orphanStatus" IS NOT NULL THEN 1 ELSE 0 END) AS "orphanCount"` : ''}
        FROM "Identities"
      `),
      timedRequest(p, 'identity-type-dist', res).query(`
        SELECT "accountType", COUNT(*) AS cnt
        FROM "IdentityMembers"
        GROUP BY "accountType"
        ORDER BY cnt DESC
      `),
    ]);
    const summary = summaryResult.recordset[0];
    summary.accountTypeDistribution = typeDistResult.recordset;

    // Build filtered query
    let where = 'WHERE 1=1';
    const inputs = {};

    if (search) {
      where += ` AND ("displayName" ILIKE @search OR email ILIKE @search OR "jobTitle" ILIKE @search OR "employeeId" ILIKE @search)`;
      inputs.search = `%${search}%`;
    }

    if (minAccounts) {
      const min = parseInt(minAccounts);
      if (min > 1) {
        where += ' AND "accountCount" >= @minAccounts';
        inputs.minAccounts = min;
      }
    }

    if (confidence) {
      where += ' AND "correlationConfidence" >= @confidence';
      inputs.confidence = parseInt(confidence);
    }

    if (verified === 'true') {
      where += ' AND "analystVerified" = true';
    } else if (verified === 'false') {
      where += ' AND "analystVerified" = false';
    }

    if (hasHrCols) {
      if (hrAnchored === 'true') {
        where += ' AND "isHrAnchored" = true';
      } else if (hrAnchored === 'false') {
        where += ' AND ("isHrAnchored" = false OR "isHrAnchored" IS NULL)';
      }

      if (orphanStatus === 'any') {
        where += ' AND "orphanStatus" IS NOT NULL';
      } else if (orphanStatus === 'none') {
        where += ' AND "orphanStatus" IS NULL';
      } else if (orphanStatus) {
        where += ' AND "orphanStatus" = @orphanStatus';
        inputs.orphanStatus = orphanStatus;
      }
    }

    // Apply the attribute filters that useEntityPage sends (simple
    // field=value equality on whitelisted columns).
    const IDENTITY_FILTER_COLS = new Set([
      'displayName', 'email', 'department', 'jobTitle', 'companyName',
      'city', 'country', 'employeeId', 'accountCount',
    ]);
    for (const [field, value] of Object.entries(attrFilters)) {
      if (!IDENTITY_FILTER_COLS.has(field)) continue;
      if (value == null || value === '') continue;
      const key = `flt_${field}`;
      where += ` AND "${field}" = @${key}`;
      inputs[key] = value;
    }

    // Tag filter (virtual field).
    let identityTagJoin = '';
    if (identityTagFilter) {
      identityTagJoin = `
        INNER JOIN "GraphTagAssignments" _ita ON _ita."entityId" = UPPER(i.id::text)
        INNER JOIN "GraphTags" _it ON _ita."tagId" = _it.id
          AND _it."name" = @__identityTag AND _it."entityType" = 'identity'`;
      inputs.__identityTag = identityTagFilter;
    }

    // Sort
    const ALLOWED_SORTS = {
      'accountCount': '"accountCount" DESC',
      'confidence': '"correlationConfidence" DESC',
      'displayName': '"displayName" ASC',
      'department': 'department ASC',
      'correlatedAt': '"correlatedAt" DESC',
    };
    const orderBy = ALLOWED_SORTS[sort] || '"displayName" ASC';

    // Count + paginated data are independent — run them in parallel too.
    const countReq = timedRequest(p, 'identity-count', res);
    for (const [k, v] of Object.entries(inputs)) countReq.input(k, v);

    const dataReq = timedRequest(p, 'identity-list', res);
    for (const [k, v] of Object.entries(inputs)) dataReq.input(k, v);
    dataReq.input('pageOffset', pageOffset);
    dataReq.input('pageLimit', pageLimit);

    const [countResult, dataResult] = await Promise.all([
      countReq.query(`SELECT COUNT(*)::int AS total FROM "Identities" i ${identityTagJoin} ${where}`),
      dataReq.query(`
        SELECT i.id, i."displayName", i."primaryPrincipalId" AS "primaryAccountId", i.email AS "primaryAccountUpn",
          i."accountCount", NULL AS "accountTypes",
          i."correlationConfidence", NULL AS "correlationSignals", i.department, i."jobTitle",
          NULL AS "managerId", i.email AS mail,
          i."givenName", i.surname, i."employeeId", i."companyName", NULL AS "employeeType",
          i.city, i.country, i."officeLocation",
          NULL AS "accountEnabled", i."correlatedAt", i."analystVerified", i."analystNotes",
          (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
             FROM "GraphTagAssignments" ta
             INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" = 'identity'
            WHERE ta."entityId" = UPPER(i.id::text)
          ) AS "tagString"
          ${hasHrCols ? ', i."isHrAnchored", NULL AS "hrAccountId", i."orphanStatus"' : ''}
        FROM "Identities" i
        ${identityTagJoin}
        ${where}
        ORDER BY ${orderBy}
        LIMIT @pageLimit OFFSET @pageOffset
      `),
    ]);
    const total = countResult.recordset[0].total;
    const data = dataResult.recordset.map(row => {
      const { tagString, ...rest } = row;
      return { ...rest, tags: parseTagString(tagString) };
    });

    res.json({
      available: true,
      summary,
      data,
      total,
      hasHrColumns: hasHrCols,
    });
  } catch (err) {
    console.error('Error fetching identities:', err.message);
    res.status(500).json({ error: 'Failed to fetch identities' });
  }
});

// GET /api/identities/:id — single identity with all linked accounts
router.get('/identities/:id', async (req, res) => {
  if (!useSql) return res.status(404).json({ error: 'SQL not configured' });

  const identityId = req.params.id;
  if (!UUID_RE.test(identityId)) return res.status(400).json({ error: 'Invalid identity ID' });

  try {
    const p = await db.getPool();

    // Fetch identity. Context membership is no longer a column on Identities
    // (v6 context redesign) — membership now lives in ContextMembers and is
    // surfaced through the dedicated /api/contexts/* endpoints.
    const identityResult = await timedRequest(p, 'identity-detail', res)
      .input('id', identityId)
      .query(`SELECT i.* FROM "Identities" i WHERE i.id = @id`);

    if (identityResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Identity not found' });
    }

    const identity = identityResult.recordset[0];

    // Fetch all member accounts — try Principals first (userId column), fall back to GraphUsers
    // IdentityMembers stores displayName opportunistically; many rows have
    // null there so we coalesce with the Principals record and pull UPN out
    // of Principals.email (v5 has no separate userPrincipalName column).
    let membersResult;
    try {
      membersResult = await timedRequest(p, 'identity-members', res)
        .input('identityId', identityId)
        .query(`
          SELECT m."identityId", m."principalId", m."isPrimary", m."isHrAuthoritative",
                 m."accountType", m."accountTypePattern", m."accountEnabled",
                 m."correlationSignals", m."signalConfidence", m."hrScore",
                 m."hrIndicators", m."analystOverride",
                 COALESCE(m."displayName", u."displayName") AS "displayName",
                 u.email AS "userPrincipalName",
                 u.department, u."jobTitle", u."createdDateTime",
                 u."accountEnabled" AS "userAccountEnabled"
          FROM "IdentityMembers" m
          LEFT JOIN "Principals" u ON m."principalId" = u.id
          WHERE m."identityId" = @identityId
          ORDER BY m."isPrimary" DESC NULLS LAST, m."accountType" ASC
        `);
    } catch {
      membersResult = await timedRequest(p, 'identity-members-legacy', res)
        .input('identityId', identityId)
        .query(`
          SELECT m.*, u.department, u."jobTitle", u.lastSignInDateTime, u."createdDateTime", u."accountEnabled" AS "userAccountEnabled"
          FROM "IdentityMembers" m
          LEFT JOIN GraphUsers u ON m."principalId" = u.id
          WHERE m."identityId" = @identityId
          ORDER BY m."isPrimary" DESC, m."accountType" ASC
        `);
    }

    // Enrich members with risk scores (optional — try Principals then GraphUsers)
    let memberRiskMap = {};
    try {
      let riskResult;
      try {
        riskResult = await timedRequest(p, 'identity-member-risks', res)
          .input('identityId', identityId)
          .query(`
            SELECT m."principalId", u."riskScore", u."riskTier"
            FROM "IdentityMembers" m
            LEFT JOIN "Principals" u ON m."principalId" = u.id
            WHERE m."identityId" = @identityId
          `);
      } catch {
        riskResult = await timedRequest(p, 'identity-member-risks-legacy', res)
          .input('identityId', identityId)
          .query(`
            SELECT m."principalId", u."riskScore", u."riskTier"
            FROM "IdentityMembers" m
            LEFT JOIN GraphUsers u ON m."principalId" = u.id
            WHERE m."identityId" = @identityId
          `);
      }
      for (const r of riskResult.recordset) {
        memberRiskMap[r.userId] = { riskScore: r.riskScore, riskTier: r.riskTier };
      }
    } catch { /* risk columns may not exist yet */ }

    // Fetch group memberships per account for context
    let memberGroupCounts = [];
    try {
      const groupCountResult = await timedRequest(p, 'identity-member-groups', res)
        .input('identityId', identityId)
        .query(`
          SELECT m."principalId", COUNT(DISTINCT gm."resourceId") AS "groupCount"
          FROM "IdentityMembers" m
          LEFT JOIN "ResourceAssignments" gm ON m."principalId" = gm."principalId" AND gm."assignmentType" = 'Direct'
          WHERE m."identityId" = @identityId
          GROUP BY m."principalId"
        `);
      memberGroupCounts = groupCountResult.recordset;
    } catch {
      // ResourceAssignments may not exist
    }

    // Enrich members with group counts and risk scores
    const groupCountMap = {};
    for (const gc of memberGroupCounts) {
      groupCountMap[gc.userId] = gc.groupCount;
    }
    for (const member of membersResult.recordset) {
      member.groupCount = groupCountMap[member.userId] || 0;
      if (memberRiskMap[member.userId]) {
        member.riskScore = memberRiskMap[member.userId].riskScore;
        member.riskTier = memberRiskMap[member.userId].riskTier;
      }
    }

    // Aggregate relationship counts across every linked account — the entity
    // graph shows these as nodes ("32 groups across 3 accounts", "4 access
    // packages"). One query joins IdentityMembers to ResourceAssignments and
    // groups by assignmentType so we stay cheap.
    const aggregate = { Direct: 0, Governed: 0, Owner: 0, Eligible: 0, OAuth2Grant: 0 };
    try {
      const aggResult = await timedRequest(p, 'identity-aggregate-counts', res)
        .input('identityId', identityId)
        .query(`
          SELECT ra."assignmentType", COUNT(DISTINCT ra."resourceId")::int AS cnt
          FROM "IdentityMembers" m
          JOIN "ResourceAssignments" ra ON ra."principalId" = m."principalId"
          WHERE m."identityId" = @identityId
          GROUP BY ra."assignmentType"
        `);
      for (const row of aggResult.recordset) {
        if (row.assignmentType in aggregate) aggregate[row.assignmentType] = row.cnt;
      }
    } catch { /* ResourceAssignments may not exist */ }

    res.json({
      identity,
      members: membersResult.recordset,
      aggregateAssignments: aggregate,
    });
  } catch (err) {
    console.error('Error fetching identity detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch identity detail' });
  }
});

// GET /api/identities/:id/assignments?type=Direct|Governed|Owner|Eligible|OAuth2Grant
// Flattens assignments across every linked account — used by the identity
// detail graph when the user clicks a relationship node.
router.get('/identities/:id/assignments', async (req, res) => {
  if (!useSql) return res.json([]);
  const identityId = req.params.id;
  if (!UUID_RE.test(identityId)) return res.status(400).json({ error: 'Invalid identity ID' });
  const ALLOWED = ['Direct', 'Governed', 'Owner', 'Eligible', 'OAuth2Grant'];
  const type = req.query.type;
  if (!ALLOWED.includes(type)) return res.status(400).json({ error: 'Invalid assignment type' });

  try {
    const p = await db.getPool();
    const r = await timedRequest(p, 'identity-assignments', res)
      .input('identityId', identityId)
      .input('type', type)
      .query(`
        SELECT ra."resourceId",
               r."displayName"   AS "resourceDisplayName",
               r."resourceType",
               m."principalId",
               COALESCE(p."displayName", m."displayName") AS "principalDisplayName",
               p."email"         AS "userPrincipalName",
               m."accountType",
               m."isPrimary",
               ra.state,
               ra."assignmentStatus",
               ra."expirationDateTime"
        FROM "IdentityMembers" m
        JOIN "ResourceAssignments" ra ON ra."principalId" = m."principalId"
        LEFT JOIN "Resources" r ON r.id = ra."resourceId"
        LEFT JOIN "Principals" p ON p.id = m."principalId"
        WHERE m."identityId" = @identityId
          AND ra."assignmentType" = @type
        ORDER BY r."displayName", p."displayName"
      `);
    res.json(r.recordset);
  } catch (err) {
    console.error('Error fetching identity assignments:', err.message);
    res.status(500).json({ error: 'Failed to fetch identity assignments' });
  }
});

// PUT /api/identities/:id/verify — mark as analyst-verified
router.put('/identities/:id/verify', async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL not configured' });

  const identityId = req.params.id;
  if (!UUID_RE.test(identityId)) return res.status(400).json({ error: 'Invalid identity ID' });

  const { notes } = req.body || {};
  if (notes && notes.length > 2000) {
    return res.status(400).json({ error: 'Notes must be 2000 characters or fewer' });
  }

  try {
    const p = await db.getPool();
    await timedRequest(p, 'identity-verify', res)
      .input('id', identityId)
      .input('notes', notes || null)
      .query(`UPDATE "Identities" SET "analystVerified" = TRUE, "analystNotes" = @notes WHERE id = @id`);

    res.json({ success: true });
  } catch (err) {
    console.error('Error verifying identity:', err.message);
    res.status(500).json({ error: 'Failed to verify identity' });
  }
});

// DELETE /api/identities/:id/verify — remove verification
router.delete('/identities/:id/verify', async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL not configured' });

  const identityId = req.params.id;
  if (!UUID_RE.test(identityId)) return res.status(400).json({ error: 'Invalid identity ID' });

  try {
    const p = await db.getPool();
    await timedRequest(p, 'identity-unverify', res)
      .input('id', identityId)
      .query(`UPDATE "Identities" SET "analystVerified" = FALSE, "analystNotes" = NULL WHERE id = @id`);

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing identity verification:', err.message);
    res.status(500).json({ error: 'Failed to remove verification' });
  }
});

// PUT /api/identities/:id/members/:userId/override — analyst override on member
router.put('/identities/:id/members/:userId/override', async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL not configured' });

  const { id: identityId, userId } = req.params;
  if (!UUID_RE.test(identityId) || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  const { action, reason } = req.body || {};
  if (!action || !['confirmed', 'rejected', 'moved'].includes(action)) {
    return res.status(400).json({ error: 'Action must be one of: confirmed, rejected, moved' });
  }
  if (!reason || reason.trim().length < 3) {
    return res.status(400).json({ error: 'Reason is required (min 3 characters)' });
  }
  if (reason.length > 500) {
    return res.status(400).json({ error: 'Reason must be 500 characters or fewer' });
  }

  try {
    const p = await db.getPool();
    await timedRequest(p, 'identity-member-override', res)
      .input('identityId', identityId)
      .input('userId', userId)
      .input('action', action)
      .input('reason', reason.trim())
      .query(`
        UPDATE "IdentityMembers"
        SET "analystOverride" = @action, analystReason = @reason
        WHERE "identityId" = @identityId AND "userId" = @userId
      `);

    res.json({ success: true, action, reason: reason.trim() });
  } catch (err) {
    console.error('Error setting member override:', err.message);
    res.status(500).json({ error: 'Failed to set member override' });
  }
});

// GET /api/identities/by-user/:userId — returns the identity a user belongs to (if any)
router.get('/identities/by-user/:userId', async (req, res) => {
  if (!useSql) return res.json({ identity: null, memberInfo: null });

  const userId = req.params.userId;
  if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  try {
    const p = await db.getPool();

    if (!(await hasTable(p, 'Identities'))) {
      return res.json({ identity: null, memberInfo: null });
    }

    // Find identity membership for this user. Identities has `email`, not
    // `primaryAccountUpn` / `primaryAccountId` columns — map them through
    // aliases so the response keeps the field names the frontend expects.
    const memberResult = await timedRequest(p, 'identity-by-user-member', res)
      .input('userId', userId)
      .query(`
        SELECT i.id AS "identityId", i."displayName" AS "identityDisplayName", i."accountCount",
          i.email AS "primaryAccountUpn", i."primaryPrincipalId" AS "primaryAccountId",
          i."correlationConfidence", i."isHrAnchored",
          m."accountType", m."isPrimary", m."isHrAuthoritative", m."hrScore", m."signalConfidence",
          m."correlationSignals", m."analystOverride"
        FROM "IdentityMembers" m
        JOIN "Identities" i ON i.id = m."identityId"
        WHERE m."principalId" = @userId
      `);

    if (memberResult.recordset.length === 0) {
      return res.json({ identity: null, memberInfo: null });
    }

    const row = memberResult.recordset[0];
    const identity = {
      id: row.identityId,
      displayName: row.identityDisplayName,
      accountCount: row.accountCount,
      primaryAccountUpn: row.primaryAccountUpn,
      primaryAccountId: row.primaryAccountId,
      correlationConfidence: row.correlationConfidence,
      isHrAnchored: row.isHrAnchored,
    };
    const memberInfo = {
      accountType: row.accountType,
      isPrimary: row.isPrimary,
      isHrAuthoritative: row.isHrAuthoritative,
      hrScore: row.hrScore,
      signalConfidence: row.signalConfidence,
      correlationSignals: row.correlationSignals,
      analystOverride: row.analystOverride,
    };

    // Fetch other accounts in the same identity for context
    const othersResult = await timedRequest(p, 'identity-by-user-others', res)
      .input('identityId', row.identityId)
      .input('userId', userId)
      .query(`
        SELECT "userId", "displayName", userPrincipalName, "accountType", "isPrimary",
          "isHrAuthoritative", "accountEnabled"
        FROM "IdentityMembers"
        WHERE "identityId" = @identityId AND "userId" <> @userId
        ORDER BY "isPrimary" DESC, "accountType" ASC
      `);

    res.json({ identity, memberInfo, otherMembers: othersResult.recordset });
  } catch (err) {
    console.error('Error fetching identity by user:', err.message);
    res.status(500).json({ error: 'Failed to fetch identity' });
  }
});

// DELETE /api/identities/:id/members/:userId/override — remove analyst override
router.delete('/identities/:id/members/:userId/override', async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL not configured' });

  const { id: identityId, userId } = req.params;
  if (!UUID_RE.test(identityId) || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  try {
    const p = await db.getPool();
    await timedRequest(p, 'identity-member-remove-override', res)
      .input('identityId', identityId)
      .input('userId', userId)
      .query(`
        UPDATE "IdentityMembers"
        SET "analystOverride" = NULL, analystReason = NULL
        WHERE "identityId" = @identityId AND "userId" = @userId
      `);

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing member override:', err.message);
    res.status(500).json({ error: 'Failed to remove member override' });
  }
});

// ─── GET /api/identity-columns ──────────────────────────────────────────
// Column discovery for the Identities page filter bar. Returns distinct
// values for a small whitelist of filterable columns, plus the virtual
// __identityTag column populated with existing tag names. Mirrors the
// /api/resource-columns shape the useEntityPage hook expects.
router.get('/identity-columns', async (req, res) => {
  if (!useSql) return res.json([]);
  const schemaOnly = req.query.schema === 'true';
  const FILTER_COLS = [
    'displayName', 'email', 'department', 'jobTitle',
    'companyName', 'city', 'country', 'employeeId',
  ];
  try {
    const p = await db.getPool();
    if (!(await hasTable(p, 'Identities'))) return res.json([]);

    const grouped = {};
    if (schemaOnly) {
      for (const col of FILTER_COLS) grouped[col] = [];
    } else {
      // One pass per column — each read is cheap (a few hundred distinct
      // values at most on a real tenant) and keeps the SQL trivial.
      for (const col of FILTER_COLS) {
        try {
          const r = await p.request().query(
            `SELECT DISTINCT "${col}" AS v FROM "Identities" WHERE "${col}" IS NOT NULL AND "${col}" <> '' ORDER BY "${col}" LIMIT 500`
          );
          grouped[col] = r.recordset.map(x => x.v);
        } catch { grouped[col] = []; }
      }
    }

    // Virtual tag-name column.
    try {
      const r = await p.request().query(`
        SELECT t.name
          FROM "GraphTags" t
         WHERE t."entityType" = 'identity'
           AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
         ORDER BY t.name
      `);
      grouped['__identityTag'] = schemaOnly ? [] : r.recordset.map(x => x.name);
    } catch { /* GraphTags may not exist yet */ }

    return res.json(Object.entries(grouped).map(([column, values]) => ({ column, values })));
  } catch (err) {
    console.error('identity-columns failed:', err.message);
    return res.json([]);
  }
});

export default router;
