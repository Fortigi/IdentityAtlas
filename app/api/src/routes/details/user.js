// User detail endpoints — /api/user/:id and its lazy-loaded sub-resources.
//
// Extracted verbatim from routes/details.js (audit finding C1). Mounted by
// routes/details.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { useSql, UUID_RE, cleanRow, fetchHistory } from './shared.js';
import {
  fetchUserAttributes, mergeUserRiskScore, fetchUserTags, fetchMembershipBreakdown,
  fetchUserAccessPackageCount, fetchUserHistoryCount, fetchOauth2GrantCount,
  fetchDirectReportCount, fetchUserContextCount, fetchPrincipalRelationships,
} from './userDetail.js';

const router = Router();

// ────────────────────────────────────────────────────────────────
// GET /api/user/:id — Lightweight: attributes, tags, counts only
// ────────────────────────────────────────────────────────────────
router.get('/user/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: {}, tags: [], membershipCount: 0, accessPackageCount: 0, hasHistory: false });
  try {
    const pool = await db.getPool();
    const userId = req.params.id;

    // Attributes first — a missing row is a 404 before we fetch the rest.
    const attributes = await fetchUserAttributes(pool, res, userId);
    if (attributes === null) {
      return res.status(404).json({ error: 'User not found' });
    }
    await mergeUserRiskScore(attributes, userId);

    // The remaining sections are independent optional fetches; each swallows a
    // missing optional table and rethrows anything else to the 500 below.
    const tags = await fetchUserTags(pool, res, userId);
    const { membershipCount, membershipByType } = await fetchMembershipBreakdown(pool, res, userId);
    const accessPackageCount = await fetchUserAccessPackageCount(pool, res, userId);
    const historyCount = await fetchUserHistoryCount(userId);
    const oauth2GrantCount = await fetchOauth2GrantCount(pool, res, userId);
    const directReportCount = await fetchDirectReportCount(pool, res, userId);
    const contextCount = await fetchUserContextCount(pool, res, userId);
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
    const r = await timedQuery(pool, 'user-principal-relationships-list', res, `SELECT p.id AS "principalId", p."displayName", p."principalType",
                     p."accountEnabled", pr."relationshipType"
                FROM "PrincipalRelationships" pr
                JOIN "Principals" p ON p.id = pr."${joinCol}"
               WHERE pr."${matchCol}"::text = $1 AND pr."relationshipType" = $2
               ORDER BY p."displayName"`, [req.params.id, type]);
    res.json(r.rows);
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
    const r = await timedQuery(pool, 'user-contexts', res, `SELECT DISTINCT ON (c.id) c.id, c."displayName", c."contextType", c."targetType", c.variant
                FROM "ContextMembers" cm
                JOIN "Contexts" c ON c.id = cm."contextId"
               WHERE (cm."memberType" = 'Principal' AND cm."memberId"::text = $1)
                  OR (cm."memberType" = 'Identity'  AND cm."memberId"::text IN (
                        SELECT im."identityId"::text FROM "IdentityMembers" im
                         WHERE im."principalId"::text = $1))
               ORDER BY c.id, c."contextType", c."displayName"`, [req.params.id]);
    res.json(r.rows);
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
    const r = await timedQuery(pool, 'user-memberships', res, `
      SELECT p."resourceId", p."resourceId" AS "groupId",
             r."displayName" AS "resourceDisplayName", r."displayName" AS "groupDisplayName",
             r."resourceType", r."resourceType" AS "groupTypeCalculated",
             p."membershipType", p."managedByAccessPackage", false AS "deleted"
        FROM "vw_ResourceUserPermissionAssignments" p
        LEFT JOIN "Resources" r ON p."resourceId" = r.id
       WHERE p."principalId"::text = $1
      UNION ALL
      -- Historical access: the assignment or its resource is soft-deleted, so the
      -- matview hid it. Surface it flagged so the person keeps their access history.
      SELECT ra."resourceId", ra."resourceId" AS "groupId",
             r."displayName" AS "resourceDisplayName", r."displayName" AS "groupDisplayName",
             r."resourceType", r."resourceType" AS "groupTypeCalculated",
             ra."assignmentType" AS "membershipType", false AS "managedByAccessPackage", true AS "deleted"
        FROM "ResourceAssignments" ra
        LEFT JOIN "Resources" r ON ra."resourceId" = r.id
       WHERE ra."principalId"::text = $1
         AND (ra."deletedAt" IS NOT NULL OR r."deletedAt" IS NOT NULL)
       ORDER BY "resourceDisplayName", "membershipType"
    `, [req.params.id]);
    res.json(r.rows);
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
    const r = await timedQuery(pool, 'user-access-packages', res, `
      SELECT DISTINCT
        a."resourceId",
        ap."displayName" AS "accessPackageName",
        a."state",
        a."expirationDateTime"
        FROM "ResourceAssignments" a
        JOIN "Resources" ap ON a."resourceId" = ap.id AND ap."governanceResource"
       WHERE a."principalId"::text = $1
       ORDER BY ap."displayName"
    `, [req.params.id]);
    res.json(r.rows);
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
    const r = await timedQuery(pool, 'user-oauth2-grants', res, `
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
       WHERE a."principalId"::text = $1
         AND a."assignmentType" = 'OAuth2Grant'
       ORDER BY client_res."displayName", scope_res."displayName"
    `, [req.params.id]);
    res.json(r.rows);
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
