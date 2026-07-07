import { Router } from 'express';
import * as db from '../db/connection.js';
import { timedRequest } from '../perf/sqlTimer.js';
import { isMissingSchema } from '../db/schemaErrors.js';

const router = Router();

const useSql = process.env.USE_SQL === 'true';
const SYSTEM_COLS = new Set(['SysStartTime', 'SysEndTime']);
const UUID_RE = /^[0-9a-f-]{36}$/i;

function cleanRow(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row)) {
    if (!SYSTEM_COLS.has(key)) clean[key] = value;
  }
  return clean;
}

async function getPermissionTable(_pool) {
  // v5: only the unified view exists. No materialized fallback needed.
  return '"vw_ResourceUserPermissionAssignments"';
}

// Fetch the version history of a single row from the v5 `_history` audit table.
// Returns rows shaped like the v4 SQL Server temporal-table query: each row has
// every column of the source table at that point in time, plus ValidFrom and
// (synthesised) ValidTo. Newest first. The frontend's diff logic compares
// consecutive rows so the shape has to match what v4 returned.
async function fetchHistory(tableName, rowId) {
  const r = await db.query(
    `SELECT operation, "changedAt", "rowData"
       FROM "_history"
      WHERE "tableName" = $1 AND "rowId" = $2
      ORDER BY "changedAt" DESC`,
    [tableName, rowId]
  );
  // Synthesise ValidFrom/ValidTo: ValidFrom is this row's changedAt, ValidTo
  // is the *next* (newer) row's changedAt — i.e. the moment this version
  // stopped being current. The newest row's ValidTo is left null (still current).
  return r.rows.map((row, idx) => {
    const data = row.rowData || {};
    const newer = idx > 0 ? r.rows[idx - 1] : null;
    return {
      ...data,
      ValidFrom: row.changedAt,
      ValidTo: newer ? newer.changedAt : null,
      _operation: row.operation,
    };
  });
}

async function countHistory(tableName, rowId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM "_history" WHERE "tableName" = $1 AND "rowId" = $2`,
    [tableName, rowId]
  );
  return r.rows[0]?.cnt ?? 0;
}

// ────────────────────────────────────────────────────────────────
// GET /api/user/:id — Lightweight: attributes, tags, counts only
// ────────────────────────────────────────────────────────────────
router.get('/user/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: {}, tags: [], membershipCount: 0, accessPackageCount: 0, hasHistory: false });
  try {
    const pool = await db.getPool();
    const userId = req.params.id;

    // 1. Current attributes from Principals (v5 has no GraphUsers fallback)
    const userResult = await timedRequest(pool, 'user-attributes', res)
      .input('id', userId)
      .query(`SELECT p.*, s."displayName" AS "systemDisplayName"
                FROM "Principals" p
                LEFT JOIN "Systems" s ON p."systemId" = s.id
                WHERE p.id = @id`);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const attributes = cleanRow(userResult.recordset[0]);

    // extendedAttributes is jsonb (already parsed)
    if (attributes.extendedAttributes) {
      attributes.extendedAttributesParsed = attributes.extendedAttributes;
    }

    // 1b. Risk score — stored in RiskScores keyed by (entityId, entityType),
    //     not on the Principal row. Merge the risk fields onto attributes so
    //     the detail page's Risk tab can render them.
    try {
      const rs = await db.query(
        `SELECT "riskScore", "riskTier", "riskDirectScore", "riskMembershipScore",
                "riskStructuralScore", "riskPropagatedScore", "riskExplanation",
                "riskClassifierMatches", "riskOverride", "riskOverrideReason", "riskScoredAt"
           FROM "RiskScores"
          WHERE "entityId"::text = $1 AND "entityType" = 'Principal'
          LIMIT 1`,
        [userId]
      );
      if (rs.rows.length > 0) Object.assign(attributes, cleanRow(rs.rows[0]));
    } catch (e) { if (!isMissingSchema(e)) throw e; /* RiskScores may not exist on older deployments */ }

    // 2. Tags
    let tags = [];
    try {
      const r = await timedRequest(pool, 'user-tags', res)
        .input('id', userId)
        .query(`
          SELECT t.id, t."name", t."color"
            FROM "GraphTagAssignments" ta
            JOIN "GraphTags" t ON ta."tagId" = t.id
           WHERE ta."entityId" = @id AND t."entityType" = 'user'
        `);
      tags = r.recordset;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 3. Counts — assignments broken down by the universal assignmentType so the
    //    entity graph can show a node per type (Direct / Indirect / Eligible) without
    //    pulling the full list. Each bucket spans every resourceType held that way
    //    (Group, GroupOwnership, AppRole, DelegatedPermission, …). Owner / OAuth2Grant
    //    are retired types — those rows now collapse into Direct with their own
    //    resourceType, so no separate bucket here.
    const membershipByType = { Direct: 0, Indirect: 0, Eligible: 0 };
    let membershipCount = 0;
    try {
      const r = await timedRequest(pool, 'user-membership-breakdown', res)
        .input('id', userId)
        .query(`SELECT "membershipType",
                       COUNT(DISTINCT "resourceId")::int AS cnt
                  FROM "vw_ResourceUserPermissionAssignments"
                 WHERE "principalId"::text = @id
                 GROUP BY "membershipType"`);
      for (const row of r.recordset) {
        if (row.membershipType in membershipByType) membershipByType[row.membershipType] = row.cnt;
      }
      membershipCount = Object.values(membershipByType).reduce((a, b) => a + b, 0);
    } catch (e) { if (!isMissingSchema(e)) throw e; /* view may not exist */ }

    let accessPackageCount = 0;
    try {
      const r = await timedRequest(pool, 'user-ap-count', res)
        .input('id', userId)
        .query(`SELECT COUNT(DISTINCT ra."resourceId")::int AS cnt
                  FROM "ResourceAssignments" ra
                  JOIN "Resources" r ON r.id = ra."resourceId"
                 WHERE ra."principalId"::text = @id
                   AND r."governanceResource"`);
      accessPackageCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    let historyCount = 0;
    try { historyCount = await countHistory('Principals', userId); } catch (e) { if (!isMissingSchema(e)) throw e; /* _history may not exist */ }

    let oauth2GrantCount = 0;
    try {
      const r = await timedRequest(pool, 'user-oauth2-grant-count', res)
        .input('id', userId)
        .query(`SELECT COUNT(*)::int AS cnt
                  FROM "ResourceAssignments"
                 WHERE "principalId"::text = @id AND "assignmentType" = 'OAuth2Grant'`);
      oauth2GrantCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* column may not exist on older deployments */ }

    // Direct-report count: cheap query on managerId FK.
    let directReportCount = 0;
    try {
      const r = await timedRequest(pool, 'user-reports-count', res)
        .input('id', userId)
        .query(`SELECT COUNT(*)::int AS cnt FROM "Principals" WHERE "managerId" = @id`);
      directReportCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* managerId may not exist on older deployments */ }

    // Context-membership count (v6 — replaces the old Principals.contextId
    // single-context column with a many-to-many ContextMembers join).
    // A user belongs to a context either directly as a Principal member
    // (memberType='Principal', memberId=principalId — how Principal-targeted
    // contexts like Tags store it) or, for an Identity-targeted context, via their
    // linked Identity. The old query only checked the Identity path, but Principal
    // is what the write path (contexts.js: memberType=targetType) actually stores —
    // so every user showed 0 contexts.
    let contextCount = 0;
    try {
      const r = await timedRequest(pool, 'user-context-count', res)
        .input('id', userId)
        .query(`SELECT COUNT(DISTINCT cm."contextId")::int AS cnt
                  FROM "ContextMembers" cm
                 WHERE (cm."memberType" = 'Principal' AND cm."memberId"::text = @id)
                    OR (cm."memberType" = 'Identity'  AND cm."memberId"::text IN (
                          SELECT im."identityId"::text FROM "IdentityMembers" im
                           WHERE im."principalId"::text = @id))`);
      contextCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* ContextMembers may not exist on older deployments */ }

    res.json({
      attributes,
      tags,
      membershipCount,
      membershipByType,
      accessPackageCount,
      historyCount,
      hasHistory: historyCount > 0,
      oauth2GrantCount,
      directReportCount,
      contextCount,
      lastActivity: null,
    });
  } catch (err) {
    console.error('Error fetching user detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/user/:id/contexts — Lazy-loaded context memberships (v6)
// ────────────────────────────────────────────────────────────────
router.get('/user/:id/contexts', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedRequest(pool, 'user-contexts', res)
      .input('id', req.params.id)
      .query(`SELECT DISTINCT ON (c.id) c.id, c."displayName", c."contextType", c."targetType", c.variant
                FROM "ContextMembers" cm
                JOIN "Contexts" c ON c.id = cm."contextId"
               WHERE (cm."memberType" = 'Principal' AND cm."memberId"::text = @id)
                  OR (cm."memberType" = 'Identity'  AND cm."memberId"::text IN (
                        SELECT im."identityId"::text FROM "IdentityMembers" im
                         WHERE im."principalId"::text = @id))
               ORDER BY c.id, c."contextType", c."displayName"`);
    res.json(r.recordset);
  } catch (err) {
    console.error('Error fetching user contexts:', err.message);
    res.status(500).json({ error: 'Failed to fetch user contexts' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/user/:id/memberships — Lazy-loaded group memberships
// ────────────────────────────────────────────────────────────────
router.get('/user/:id/memberships', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    // v5: query the unified view directly. Columns are camelCase double-quoted.
    const r = await timedRequest(pool, 'user-memberships', res)
      .input('id', req.params.id)
      .query(`
      SELECT p."resourceId", p."resourceId" AS "groupId",
             r."displayName" AS "resourceDisplayName", r."displayName" AS "groupDisplayName",
             r."resourceType", r."resourceType" AS "groupTypeCalculated",
             p."membershipType", p."managedByAccessPackage", false AS "deleted"
        FROM "vw_ResourceUserPermissionAssignments" p
        LEFT JOIN "Resources" r ON p."resourceId" = r.id
       WHERE p."principalId"::text = @id
      UNION ALL
      -- Historical access: the assignment or its resource is soft-deleted, so the
      -- matview hid it. Surface it flagged so the person keeps their access history.
      SELECT ra."resourceId", ra."resourceId" AS "groupId",
             r."displayName" AS "resourceDisplayName", r."displayName" AS "groupDisplayName",
             r."resourceType", r."resourceType" AS "groupTypeCalculated",
             ra."assignmentType" AS "membershipType", false AS "managedByAccessPackage", true AS "deleted"
        FROM "ResourceAssignments" ra
        LEFT JOIN "Resources" r ON ra."resourceId" = r.id
       WHERE ra."principalId"::text = @id
         AND (ra."deletedAt" IS NOT NULL OR r."deletedAt" IS NOT NULL)
       ORDER BY "resourceDisplayName", "membershipType"
    `);
    res.json(r.recordset);
  } catch (err) {
    console.error('Error fetching user memberships:', err.message);
    res.status(500).json({ error: 'Failed to fetch memberships' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/user/:id/access-packages — Lazy-loaded AP assignments
// ────────────────────────────────────────────────────────────────
router.get('/user/:id/access-packages', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedRequest(pool, 'user-access-packages', res)
      .input('id', req.params.id)
      .query(`
      SELECT DISTINCT
        a."resourceId",
        ap."displayName" AS "accessPackageName",
        a."state",
        a."expirationDateTime"
        FROM "ResourceAssignments" a
        JOIN "Resources" ap ON a."resourceId" = ap.id AND ap."governanceResource"
       WHERE a."principalId"::text = @id
       ORDER BY ap."displayName"
    `);
    res.json(r.recordset);
  } catch (err) {
    console.error('Error fetching user access packages:', err.message);
    res.status(500).json({ error: 'Failed to fetch access packages' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/user/:id/oauth2-grants — Lazy-loaded OAuth2 consents
// One row per (client app, target API, scope) this user authorized.
// Joins the scope Resource → DelegatesScope ResourceRelationship → client-app
// Resource chain so the client app's displayName resolves even when
// extendedAttributes is blank.
// ────────────────────────────────────────────────────────────────
router.get('/user/:id/oauth2-grants', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedRequest(pool, 'user-oauth2-grants', res)
      .input('id', req.params.id)
      .query(`
      SELECT
        scope_res.id                       AS "scopeResourceId",
        scope_res."displayName"            AS "scopeDisplayName",
        scope_res."extendedAttributes"     AS "scopeExtendedAttributes",
        rr."parentResourceId"              AS "clientSpId",
        client_res."displayName"           AS "clientDisplayName",
        a."extendedAttributes"             AS "grantExtendedAttributes"
        FROM "ResourceAssignments" a
        JOIN "Resources" scope_res
          ON scope_res.id = a."resourceId"
         AND scope_res."resourceType" = 'DelegatedPermission'
        LEFT JOIN "ResourceRelationships" rr
          ON rr."childResourceId" = scope_res.id
         AND rr."relationshipType" = 'DelegatesScope'
        LEFT JOIN "Resources" client_res
          ON client_res.id = rr."parentResourceId"
       WHERE a."principalId"::text = @id
         AND a."assignmentType" = 'OAuth2Grant'
       ORDER BY client_res."displayName", scope_res."displayName"
    `);
    res.json(r.recordset);
  } catch (err) {
    console.error('Error fetching user oauth2 grants:', err.message);
    res.status(500).json({ error: 'Failed to fetch OAuth2 grants' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/user/:id/history — Lazy-loaded version history
// ────────────────────────────────────────────────────────────────
router.get('/user/:id/history', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const rows = await fetchHistory('Principals', req.params.id);
    res.json(rows.map(cleanRow));
  } catch (err) {
    console.error('user-history failed:', err.message);
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/group/:id — Lightweight: attributes, tags, counts only
// Now queries Resources table (new model) with GraphGroups fallback
// ────────────────────────────────────────────────────────────────
router.get('/group/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: {}, tags: [], memberCount: 0, accessPackageCount: 0, hasHistory: false });
  try {
    const pool = await db.getPool();
    const groupId = req.params.id;

    // 1. Current attributes — try Resources first, fall back to GraphGroups
    let groupResult;
    try {
      groupResult = await timedRequest(pool, 'group-attributes', res)
        .input('id', groupId)
        .query(`SELECT * FROM "Resources" WHERE id = @id`);
    } catch {
      groupResult = await timedRequest(pool, 'group-attributes-legacy', res)
        .input('id', groupId)
        .query('SELECT * FROM GraphGroups WHERE id = @id');
    }

    if (groupResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    const attributes = cleanRow(groupResult.recordset[0]);

    // Parse extendedAttributes if present (Resources model)
    if (attributes.extendedAttributes) {
      try {
        attributes.extendedAttributesParsed = JSON.parse(attributes.extendedAttributes);
      } catch (err) { console.warn('Failed to parse extendedAttributes for resource', groupId, ':', err.message); }
    }

    // 2. Tags (support both 'resource' and 'group' entity types)
    let tags = [];
    try {
      const r = await timedRequest(pool, 'group-tags', res)
        .input('id', groupId)
        .query(`
        SELECT t.id, t.name, t.color
        FROM "GraphTagAssignments" ta
        JOIN "GraphTags" t ON ta."tagId" = t.id
        WHERE ta."entityId" = @id AND t."entityType" IN ('resource', 'group')
      `);
      tags = r.recordset;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 3. Counts only (fast) — try resourceId first, fall back to groupId
    let memberCount = 0;
    try {
      const table = await getPermissionTable(pool);
      let r;
      try {
        r = await timedRequest(pool, 'group-member-count', res)
          .input('id', groupId)
          .query(`SELECT COUNT(DISTINCT "memberId") AS cnt FROM ${table} WHERE "resourceId" = @id`);
      } catch {
        r = await timedRequest(pool, 'group-member-count-legacy', res)
          .input('id', groupId)
          .query(`SELECT COUNT(DISTINCT "memberId") AS cnt FROM ${table} WHERE "groupId" = @id`);
      }
      memberCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* view may not exist */ }

    let accessPackageCount = 0;
    try {
      const r = await timedRequest(pool, 'group-ap-count', res)
        .input('id', groupId)
        .query(`
        SELECT COUNT(DISTINCT rrs."parentResourceId") AS cnt
        FROM "ResourceRelationships" rrs
        WHERE UPPER(rrs."childResourceId"::text) = UPPER(@id)
          AND rrs."relationshipType" = 'Contains'
      `);
      accessPackageCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    let historyCount = 0;
    try { historyCount = await countHistory('Resources', groupId); } catch (e) { if (!isMissingSchema(e)) throw e; /* _history table may not exist on older deployments */ }

    res.json({ attributes, tags, memberCount, accessPackageCount, historyCount, hasHistory: historyCount > 0 });
  } catch (err) {
    console.error('Error fetching group detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch group details' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/group/:id/members — Lazy-loaded group/resource members
// ────────────────────────────────────────────────────────────────
router.get('/group/:id/members', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const table = await getPermissionTable(pool);
    // The matrix matview keys members by principalId and carries membershipType +
    // managedByAccessPackage; join Principals for the display name / UPN.
    // (Previously selected memberId/memberDisplayName/memberUPN, which don't exist
    // on the v5 matview, so this endpoint always 500'd — masked by the legacy
    // fallback, which referenced an equally-absent "groupId" column.)
    const r = await timedRequest(pool, 'group-members', res)
      .input('id', req.params.id)
      .query(`
        SELECT p."principalId"     AS "memberId",
               pr."displayName"    AS "memberDisplayName",
               pr.email            AS "memberUPN",
               p."membershipType",
               p."managedByAccessPackage"
          FROM ${table} p
          JOIN "Principals" pr ON pr.id = p."principalId"
         WHERE p."resourceId" = @id
         ORDER BY pr."displayName", p."membershipType"
      `);
    res.json(r.recordset);
  } catch (err) {
    console.error('Error fetching group members:', err.message);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/group/:id/access-packages — Lazy-loaded APs for group
// ────────────────────────────────────────────────────────────────
router.get('/group/:id/access-packages', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedRequest(pool, 'group-access-packages', res)
      .input('id', req.params.id)
      .query(`
      SELECT DISTINCT
        rrs."parentResourceId" AS "resourceId",
        ap."displayName" AS "accessPackageName",
        rrs."roleName"
      FROM "ResourceRelationships" rrs
      LEFT JOIN "Resources" ap ON rrs."parentResourceId" = ap.id AND ap."resourceType" = 'BusinessRole'
      WHERE UPPER(rrs."childResourceId"::text) = UPPER(@id)
        AND rrs."relationshipType" = 'Contains'
      ORDER BY ap."displayName"
    `);
    res.json(r.recordset);
  } catch (err) {
    console.error('Error fetching group access packages:', err.message);
    res.status(500).json({ error: 'Failed to fetch access packages' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/group/:id/history — Lazy-loaded version history
// ────────────────────────────────────────────────────────────────
router.get('/group/:id/history', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const rows = await fetchHistory('Resources', req.params.id);
    res.json(rows.map(cleanRow));
  } catch (err) {
    console.error('group-history failed:', err.message);
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id — Lightweight: attributes, counts only
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: {}, assignmentCount: 0, groupCount: 0, hasHistory: false });
  try {
    const pool = await db.getPool();
    const apId = req.params.id;

    // 1. Current attributes + catalog name
    let apResult;
    try {
      apResult = await timedRequest(pool, 'ap-attributes', res)
        .input('id', apId)
        .query(`
        SELECT ap.*, c."displayName" AS "catalogName"
        FROM "Resources" ap
        LEFT JOIN "GovernanceCatalogs" c ON ap."catalogId" = c.id
        WHERE ap.id = @id AND ap."resourceType" = 'BusinessRole'
      `);
    } catch {
      // GovernanceCatalogs may not exist — fall back to AP-only query
      apResult = await timedRequest(pool, 'ap-attributes', res)
        .input('id', apId)
        .query(`SELECT * FROM "Resources" WHERE id = @id AND "resourceType" = 'BusinessRole'`);
    }

    if (apResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Access package not found' });
    }
    const attributes = cleanRow(apResult.recordset[0]);

    // 2. Assignment count
    let assignmentCount = 0;
    try {
      const r = await timedRequest(pool, 'ap-assignment-count', res)
        .input('id', apId)
        .query(`
        SELECT COUNT(*) AS cnt FROM "ResourceAssignments" WHERE "resourceId" = @id
      `);
      assignmentCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 3. Group count (resources linked to this AP)
    let groupCount = 0;
    try {
      const r = await timedRequest(pool, 'ap-group-count', res)
        .input('id', apId)
        .query(`
        SELECT COUNT(DISTINCT "childResourceId") AS cnt
        FROM "ResourceRelationships"
        WHERE "parentResourceId" = @id AND "relationshipType" = 'Contains'
      `);
      groupCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 4. Review count
    let reviewCount = 0;
    try {
      const r = await timedRequest(pool, 'ap-review-count', res)
        .input('id', apId)
        .query(`
        SELECT COUNT(*) AS cnt FROM "CertificationDecisions" WHERE "resourceId" = @id
      `);
      reviewCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 5. Pending request count — COUNT only (cheap); full rows are lazy-loaded.
    let pendingRequestCount = null;
    try {
      const r = await timedRequest(pool, 'ap-pending-request-count', res)
        .input('id', apId)
        .query(`
        SELECT COUNT(*) AS cnt FROM "AssignmentRequests"
        WHERE "resourceId" = @id AND "requestState" = 'PendingApproval'
      `);
      pendingRequestCount = r.recordset[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 5b. Last review date + reviewer
    let lastReviewDate = null;
    let lastReviewedBy = null;
    try {
      const r = await timedRequest(pool, 'ap-last-review-date', res)
        .input('id', apId)
        .query(`
        SELECT "reviewedDateTime", "reviewedByDisplayName"
        FROM "CertificationDecisions"
        WHERE "resourceId" = @id AND decision IS NOT NULL AND decision <> 'NotReviewed'
        ORDER BY "reviewedDateTime" DESC
      `);
      lastReviewDate = r.recordset[0]?.reviewedDateTime || null;
      lastReviewedBy = r.recordset[0]?.reviewedByDisplayName || null;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 5c. Compliance status of the latest review instance — the same calculated
    //     "Review Status" the Business Roles list shows. Mirrors the
    //     LAST_REVIEW_CTE logic in governance.js, scoped to one resource.
    let complianceStatus = null;
    let daysOverdue = 0;
    try {
      const r = await db.query(`
        WITH li AS (
          SELECT "reviewInstanceId", "reviewInstanceEndDateTime"
            FROM "CertificationDecisions"
           WHERE "resourceId"::text = $1
           ORDER BY "reviewInstanceEndDateTime" DESC NULLS LAST
           LIMIT 1
        )
        SELECT li."reviewInstanceEndDateTime" AS deadline,
               SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END)::int AS "notReviewed",
               SUM(CASE WHEN d.decision <> 'NotReviewed' AND d."reviewedDateTime"::date > li."reviewInstanceEndDateTime"::date THEN 1 ELSE 0 END)::int AS late
          FROM li JOIN "CertificationDecisions" d
            ON d."resourceId"::text = $1 AND d."reviewInstanceId" = li."reviewInstanceId"
         GROUP BY li."reviewInstanceEndDateTime"`, [apId]);
      const row = r.rows[0];
      if (row) {
        const deadline = row.deadline ? new Date(row.deadline) : null;
        const overdue = deadline && deadline < new Date();
        if (row.notReviewed === 0 && row.late === 0) complianceStatus = 'Compliant';
        else if (row.notReviewed > 0 && !overdue) complianceStatus = 'In Progress';
        else if (row.notReviewed > 0 && overdue) complianceStatus = 'Missed';
        else complianceStatus = 'Reviewed Late';
        if (deadline && overdue) daysOverdue = Math.floor((Date.now() - deadline.getTime()) / 86400000);
      }
    } catch (e) { if (!isMissingSchema(e)) throw e; /* CertificationDecisions may not exist */ }

    // 6. Policy summary — auto-assigned vs request-based vs auto-removal
    let policyCount = 0;
    let autoAddPolicyCount = 0;
    let autoRemovePolicyCount = 0;
    try {
      const r = await timedRequest(pool, 'ap-policy-summary', res)
        .input('id', apId)
        .query(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN "hasAutoAddRule" = TRUE THEN 1 ELSE 0 END) AS "autoAdd",
          SUM(CASE WHEN COALESCE("hasAutoAddRule", FALSE) = FALSE AND "hasAutoRemoveRule" = TRUE THEN 1 ELSE 0 END) AS "autoRemoveOnly"
        FROM "AssignmentPolicies"
        WHERE "resourceId" = @id
      `);
      policyCount = r.recordset[0].total;
      autoAddPolicyCount = r.recordset[0].autoAdd;
      autoRemovePolicyCount = r.recordset[0].autoRemoveOnly;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // Derive assignment type label
    let assignmentType = null;
    if (policyCount > 0) {
      const requestBasedCount = policyCount - autoAddPolicyCount - autoRemovePolicyCount;
      if (autoAddPolicyCount > 0 && (requestBasedCount > 0 || autoRemovePolicyCount > 0)) {
        assignmentType = 'Both';
      } else if (autoAddPolicyCount > 0) {
        assignmentType = 'Auto-assigned';
      } else if (autoRemovePolicyCount > 0) {
        assignmentType = 'Request-based with auto-removal';
      } else {
        assignmentType = 'Request-based';
      }
    }

    // 6b. Category
    let category = null;
    try {
      const { ensureCategoryTables } = await import('./categories.js');
      await ensureCategoryTables(pool);
      const r = await timedRequest(pool, 'ap-category', res)
        .input('id', apId)
        .query(`
        SELECT cat.id, cat.name, cat.color
        FROM "GovernanceCategoryAssignments" ca
        INNER JOIN "GovernanceCategories" cat ON ca."categoryId" = cat.id
        WHERE ca."resourceId" = LOWER(@id)
      `);
      if (r.recordset.length > 0) {
        category = r.recordset[0];
      }
    } catch (e) { if (!isMissingSchema(e)) throw e; /* category tables may not exist */ }

    // 7. History count (v5: queries the _history audit table)
    let historyCount = 0;
    try { historyCount = await countHistory('Resources', apId); } catch (e) { if (!isMissingSchema(e)) throw e; /* _history may not exist */ }

    res.json({ attributes, assignmentCount, groupCount, reviewCount, pendingRequestCount, lastReviewDate, lastReviewedBy, complianceStatus, daysOverdue, historyCount, hasHistory: historyCount > 0, policyCount, autoAddPolicyCount, assignmentType, category });
  } catch (err) {
    console.error('Error fetching access package detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch access package details' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/assignments — Lazy-loaded user assignments
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/assignments', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    let r;
    try {
      // v5: assignedDate comes from the _history audit table (earliest INSERT
      // for this assignment row). Falls back to NULL when no history exists.
      // ResourceAssignments has no surrogate `id` column in v5 — the primary
      // key is (resourceId, principalId, assignmentType). That means we can't
      // drive the _history lookup from a.id; the audit rows key off the
      // composite too. Skip the assignedDate lookup for now (it's a nice-to
      // have) and fall back to the assignment row itself.
      // ResourceAssignments has no surrogate `id` column in v5 — the
      // primary key is (resourceId, principalId, assignmentType). The
      // merge with main re-introduced `a.id` which 500'd the query and
      // blanked the whole assignments list again.
      r = await timedRequest(pool, 'ap-assignments', res)
        .input('id', req.params.id)
        .query(`
        SELECT
          a."principalId", a.state AS "assignmentState", a."assignmentStatus",
          u."displayName" AS "targetDisplayName",
          u.email AS "targetUPN",
          NULL::timestamptz AS "assignedDate"
        FROM "ResourceAssignments" a
        LEFT JOIN "Principals" u ON a."principalId" = u.id
        WHERE a."resourceId" = @id
          AND (a.state = 'Delivered' OR a.state IS NULL)
        ORDER BY u."displayName"
      `);
    } catch (e) {
      console.error('ap-assignments failed:', e.message);
      r = { recordset: [] };
    }
    res.json(r.recordset);
  } catch (err) {
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/resource-roles — Lazy-loaded resource role scopes
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/resource-roles', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedRequest(pool, 'ap-resource-roles', res)
      .input('id', req.params.id)
      .query(`
      SELECT
        rrs."roleName", rrs."roleOriginSystem",
        r."displayName" AS "scopeDisplayName", rrs."childResourceId", rrs."roleOriginSystem" AS "scopeOriginSystem",
        COALESCE(r."displayName", rrs."roleName") AS "groupDisplayName",
        COALESCE(r."displayName", rrs."roleName") AS "resourceDisplayName",
        r."resourceType", r."systemId"
      FROM "ResourceRelationships" rrs
      LEFT JOIN "Resources" r ON rrs."childResourceId" = r.id
      WHERE rrs."parentResourceId" = @id AND rrs."relationshipType" = 'Contains'
      ORDER BY r."displayName", rrs."roleName"
    `);
    res.json(r.recordset);
  } catch (err) {
    console.error('ap-resource-roles failed:', err.message);
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/reviews — Lazy-loaded access reviews
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/reviews', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedRequest(pool, 'ap-reviews', res)
      .input('id', req.params.id)
      .query(`
      SELECT
        id, "reviewInstanceId", "reviewDefinitionId",
        "principalDisplayName",
        "reviewedByDisplayName",
        "reviewedDateTime", decision, justification, "recommendation",
        "reviewInstanceStartDateTime", "reviewInstanceEndDateTime",
        "reviewInstanceStatus"
      FROM "CertificationDecisions"
      WHERE "resourceId" = @id
      ORDER BY "reviewedDateTime" DESC
    `);
    res.json(r.recordset);
  } catch (err) {
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/requests — Lazy-loaded assignment requests
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/requests', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    let r;
    try {
      // Try Principals first (new model — email instead of userPrincipalName)
      r = await timedRequest(pool, 'ap-requests', res)
        .input('id', req.params.id)
        .query(`
        SELECT
          req.id, req."requestType", req."requestState", req."requestStatus",
          req.justification, req."createdDateTime", req."completedDateTime",
          u."displayName" AS "requestorDisplayName", u.email AS "requestorUPN"
        FROM "AssignmentRequests" req
        LEFT JOIN "Principals" u ON req."requestorId" = u.id
        WHERE req."resourceId" = @id
          AND req."requestState" IN ('PendingApproval', 'Delivering', 'Accepted')
        ORDER BY req."createdDateTime" DESC
      `);
    } catch {
      // Fall back to GraphUsers (old model)
      r = await timedRequest(pool, 'ap-requests-legacy', res)
        .input('id', req.params.id)
        .query(`
        SELECT
          req.id, req."requestType", req."requestState", req."requestStatus",
          req.justification, req."createdDateTime", req."completedDateTime",
          u."displayName" AS "requestorDisplayName", u.userPrincipalName AS "requestorUPN"
        FROM "AssignmentRequests" req
        LEFT JOIN GraphUsers u ON req."requestorId" = u.id
        WHERE req."resourceId" = @id
          AND req."requestState" IN ('PendingApproval', 'Delivering', 'Accepted')
        ORDER BY req."createdDateTime" DESC
      `);
    }
    res.json(r.recordset);
  } catch (err) {
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/history — Lazy-loaded version history
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/history', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const rows = await fetchHistory('Resources', req.params.id);
    // Only show history for rows that were business roles at some point
    const filtered = rows.filter(r => r.resourceType === 'BusinessRole');
    res.json(filtered.map(cleanRow));
  } catch (err) {
    console.error('ap-history failed:', err.message);
    res.json([]);
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/access-package/:id/policies — Lazy-loaded assignment policies
// ────────────────────────────────────────────────────────────────
router.get('/access-package/:id/policies', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const r = await timedRequest(pool, 'ap-policies', res)
      .input('id', req.params.id)
      .query(`
      SELECT id, "displayName", description, "allowedTargetScope",
             COALESCE("hasAutoAddRule", CAST(0 AS BOOLEAN)) AS "hasAutoAddRule",
             COALESCE("hasAutoRemoveRule", CAST(0 AS BOOLEAN)) AS "hasAutoRemoveRule",
             COALESCE("hasAccessReview", CAST(0 AS BOOLEAN)) AS "hasAccessReview",
             "reviewSettings",
             JSON_VALUE("automaticRequestSettings", '$.filter.rule') AS "autoAssignmentFilter",
             "createdDateTime", "modifiedDateTime"
      FROM "AssignmentPolicies"
      WHERE "resourceId" = @id
      ORDER BY "displayName"
    `);
    res.json(r.recordset);
  } catch {
    res.json([]);
  }
});

export default router;
