// Group/resource detail endpoints — /api/group/:id and its sub-resources.
//
// Extracted verbatim from routes/details.js (audit finding C1). Mounted by
// routes/details.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { useSql, UUID_RE, cleanRow, getPermissionTable, fetchHistory, countHistory } from './shared.js';

const router = Router();

// ────────────────────────────────────────────────────────────────
// GET /api/group/:id — Lightweight: attributes, tags, counts only
// Queries the Resources table (v5).
// ────────────────────────────────────────────────────────────────
router.get('/group/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: {}, tags: [], memberCount: 0, accessPackageCount: 0, hasHistory: false });
  try {
    const pool = await db.getPool();
    const groupId = req.params.id;

    // 1. Current attributes from the Resources table (v5).
    const groupResult = await timedQuery(pool, 'group-attributes', res,
      `SELECT * FROM "Resources" WHERE id = $1`, [groupId]);

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    const attributes = cleanRow(groupResult.rows[0]);

    // Parse extendedAttributes if present (Resources model)
    if (attributes.extendedAttributes) {
      try {
        attributes.extendedAttributesParsed = JSON.parse(attributes.extendedAttributes);
      } catch (err) { console.warn('Failed to parse extendedAttributes for resource', groupId, ':', err.message); }
    }

    // 2. Tags (support both 'resource' and 'group' entity types)
    let tags = [];
    try {
      const r = await timedQuery(pool, 'group-tags', res, `
        SELECT t.id, t.name, t.color
        FROM "GraphTagAssignments" ta
        JOIN "GraphTags" t ON ta."tagId" = t.id
        WHERE ta."entityId" = UPPER($1) AND t."entityType" IN ('resource', 'group')
      `, [groupId]);
      tags = r.rows;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* table may not exist */ }

    // 3. Member count (fast). The permission view keys members by "principalId"
    //    (there is no "memberId"/"groupId" column — the old query named both and
    //    always errored into the isMissingSchema catch, so the count read 0).
    let memberCount = 0;
    try {
      const table = await getPermissionTable(pool);
      const r = await timedQuery(pool, 'group-member-count', res,
        `SELECT COUNT(DISTINCT "principalId")::int AS cnt FROM ${table} WHERE "resourceId" = $1`, [groupId]);
      memberCount = r.rows[0].cnt;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* view may not exist */ }

    let accessPackageCount = 0;
    try {
      const r = await timedQuery(pool, 'group-ap-count', res, `
        SELECT COUNT(DISTINCT rrs."parentResourceId")::int AS cnt
        FROM "ResourceRelationships" rrs
        WHERE UPPER(rrs."childResourceId"::text) = UPPER($1)
          AND rrs."relationshipType" = 'Contains'
      `, [groupId]);
      accessPackageCount = r.rows[0].cnt;
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
    const r = await timedQuery(pool, 'group-members', res, `
        SELECT p."principalId"     AS "memberId",
               pr."displayName"    AS "memberDisplayName",
               pr.email            AS "memberUPN",
               p."membershipType",
               p."managedByAccessPackage"
          FROM ${table} p
          JOIN "Principals" pr ON pr.id = p."principalId"
         WHERE p."resourceId" = $1
         ORDER BY pr."displayName", p."membershipType"
      `, [req.params.id]);
    res.json(r.rows);
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
    const r = await timedQuery(pool, 'group-access-packages', res, `
      SELECT DISTINCT
        rrs."parentResourceId" AS "resourceId",
        ap."displayName" AS "accessPackageName",
        rrs."roleName"
      FROM "ResourceRelationships" rrs
      LEFT JOIN "Resources" ap ON rrs."parentResourceId" = ap.id AND ap."resourceType" = 'BusinessRole'
      WHERE UPPER(rrs."childResourceId"::text) = UPPER($1)
        AND rrs."relationshipType" = 'Contains'
      ORDER BY ap."displayName"
    `, [req.params.id]);
    res.json(r.rows);
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

export default router;
