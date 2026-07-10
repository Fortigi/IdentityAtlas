// User detail endpoints — /api/user/:id and its lazy-loaded sub-resources.
//
// Extracted verbatim from routes/details.js (audit finding C1). Mounted by
// routes/details.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { timedRequest } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { useSql, UUID_RE, cleanRow, fetchHistory, countHistory } from './shared.js';

const router = Router();

// Principal→principal relationships (migration 057) for a user: the four
// directional counts, plus the "linked resource" (the enterprise-app Resource an
// AI agent / service principal shares its id with). Both are best-effort — absent
// on older deployments — so each guards isMissingSchema. Extracted from the
// /user/:id handler to keep that handler under its complexity ceiling.
async function fetchPrincipalRelationships(pool, userId, res) {
  const counts = { ownerCount: 0, sponsorCount: 0, ownedAgentCount: 0, sponsoredGuestCount: 0 };
  try {
    const r = await timedRequest(pool, 'user-principal-relationships', res)
      .input('id', userId)
      .query(`SELECT
                COUNT(*) FILTER (WHERE "principalId"::text = @id        AND "relationshipType" = 'Owner')::int   AS "ownerCount",
                COUNT(*) FILTER (WHERE "principalId"::text = @id        AND "relationshipType" = 'Sponsor')::int AS "sponsorCount",
                COUNT(*) FILTER (WHERE "relatedPrincipalId"::text = @id AND "relationshipType" = 'Owner')::int   AS "ownedAgentCount",
                COUNT(*) FILTER (WHERE "relatedPrincipalId"::text = @id AND "relationshipType" = 'Sponsor')::int AS "sponsoredGuestCount"
                FROM "PrincipalRelationships"
               WHERE "principalId"::text = @id OR "relatedPrincipalId"::text = @id`);
    Object.assign(counts, r.recordset[0] || {});
  } catch (e) { if (!isMissingSchema(e)) throw e; /* PrincipalRelationships may not exist on older deployments */ }

  // An AI agent / service principal is BOTH a Principal and, as an enterprise app,
  // an Application Resource with the SAME id (the SP id) — surface it so the
  // relations tab can jump to its resource view.
  let linkedResource = null;
  try {
    const r = await timedRequest(pool, 'user-linked-resource', res)
      .input('id', userId)
      .query(`SELECT id, "displayName", "resourceType"
                FROM "Resources"
               WHERE id = @id AND "resourceType" = 'Application'
               LIMIT 1`);
    if (r.recordset.length > 0) linkedResource = r.recordset[0];
  } catch (e) { if (!isMissingSchema(e)) throw e; /* Resources always exists, but be defensive */ }

  return { ...counts, linkedResource };
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

    // Principal→principal relationships + linked resource (migration 057).
    const principalRel = await fetchPrincipalRelationships(pool, userId, res);

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
      ...principalRel,
      lastActivity: null,
    });
  } catch (err) {
    console.error('Error fetching user detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/user/:id/principal-relationships — owners / sponsors and
// their reverse (agents owned / guests sponsored). One handler for all
// four directions (migration 057):
//   ?type=Owner|Sponsor  — which link kind (default Owner)
//   ?reverse=true        — I'm the related principal (owner/sponsor); return
//                          the subjects (agents I own / guests I sponsor).
//                          Default false — I'm the subject; return my owners/sponsors.
// ────────────────────────────────────────────────────────────────
router.get('/user/:id/principal-relationships', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json([]);
  const type = req.query.type === 'Sponsor' ? 'Sponsor' : 'Owner';
  const reverse = req.query.reverse === 'true';
  // reverse=false: match on principalId (subject), join the related principal.
  // reverse=true:  match on relatedPrincipalId, join the subject principal.
  const matchCol = reverse ? 'relatedPrincipalId' : 'principalId';
  const joinCol  = reverse ? 'principalId' : 'relatedPrincipalId';
  try {
    const pool = await db.getPool();
    const r = await timedRequest(pool, 'user-principal-relationships-list', res)
      .input('id', req.params.id)
      .input('type', type)
      .query(`SELECT p.id AS "principalId", p."displayName", p."principalType",
                     p."accountEnabled", pr."relationshipType"
                FROM "PrincipalRelationships" pr
                JOIN "Principals" p ON p.id = pr."${joinCol}"
               WHERE pr."${matchCol}"::text = @id AND pr."relationshipType" = @type
               ORDER BY p."displayName"`);
    res.json(r.recordset);
  } catch (err) {
    if (isMissingSchema(err)) return res.json([]);
    console.error('Error fetching principal relationships:', err.message);
    res.status(500).json({ error: 'Failed to fetch principal relationships' });
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

export default router;
