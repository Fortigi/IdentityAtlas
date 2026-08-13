// Identity detail endpoints — /api/identities/:id and its sub-resources
// (contexts, assignments, account-matrix) plus /api/identities/by-user/:userId.
//
// Extracted verbatim from routes/identities.js (audit finding C1). Mounted by
// routes/identities.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { timedQuery } from '../../perf/sqlTimer.js';
import { useSql, db, UUID_RE, hasTable, enrichMembers } from './shared.js';
import {
  fetchIdentity, fetchIdentityMembers, fetchMemberRisks, fetchMemberGroupCounts,
  aggregateIdentityAssignments, fetchIdentityContextCount,
} from './detailData.js';

const router = Router();

// Validate the :id path param as a uuid; sends the 400 and returns null on
// failure, else the id. (useSql guards vary per handler, so they stay inline.)
function requireValidIdentityId(req, res) {
  const identityId = req.params.id;
  if (!UUID_RE.test(identityId)) { res.status(400).json({ error: 'Invalid identity ID' }); return null; }
  return identityId;
}

router.get('/identities/:id', async (req, res) => {
  if (!useSql) return res.status(404).json({ error: 'SQL not configured' });

  const identityId = requireValidIdentityId(req, res);
  if (identityId === null) return;

  try {
    const p = await db.getPool();

    // Context membership is no longer a column on Identities (v6 context
    // redesign) — it now lives in ContextMembers, surfaced via /api/contexts/*.
    const identity = await fetchIdentity(p, res, identityId);
    if (identity === null) {
      return res.status(404).json({ error: 'Identity not found' });
    }

    const members = await fetchIdentityMembers(p, res, identityId);
    const riskRows = await fetchMemberRisks(p, res, identityId);
    const groupCountRows = await fetchMemberGroupCounts(p, res, identityId);
    // Attach per-account group counts + risk (keyed by principalId — see enrichMembers).
    enrichMembers(members, riskRows, groupCountRows);

    const aggregateAssignments = await aggregateIdentityAssignments(p, res, identityId);
    const contextCount = await fetchIdentityContextCount(p, res, identityId);

    res.json({ identity, members, aggregateAssignments, contextCount });
  } catch (err) {
    console.error('Error fetching identity detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch identity detail' });
  }
});

// GET /api/identities/:id/contexts — Lazy-loaded context memberships.
// An identity's contexts are those it is an Identity member of directly, plus any
// its linked principals are Principal members of (Principal-targeted contexts like
// Tags store the principal, not the identity).
router.get('/identities/:id/contexts', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const p = await db.getPool();
    const r = await timedQuery(p, 'identity-contexts', res,
      `SELECT DISTINCT ON (c.id) c.id, c."displayName", c."contextType",
                     c."targetType", c.variant
                FROM "ContextMembers" cm
                JOIN "Contexts" c ON c.id = cm."contextId"
               WHERE (cm."memberType" = 'Identity'  AND cm."memberId"::text = $1)
                  OR (cm."memberType" = 'Principal' AND cm."memberId"::text IN (
                        SELECT im."principalId"::text FROM "IdentityMembers" im
                         WHERE im."identityId"::text = $1))
               ORDER BY c.id, c."contextType", c."displayName"`, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('GET /identities/:id/contexts failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch identity contexts' });
  }
});

// GET /api/identities/:id/assignments?type=Direct|Indirect|Eligible
// Flattens assignments across every linked account — used by the identity
// detail graph when the user clicks a relationship node. The universal
// assignmentTypes are the only valid filters (Governed is a flag, Owner /
// OAuth2Grant are retired — their rows collapse into Direct).
router.get('/identities/:id/assignments', async (req, res) => {
  if (!useSql) return res.json([]);
  const identityId = requireValidIdentityId(req, res);
  if (identityId === null) return;
  const ALLOWED = ['Direct', 'Indirect', 'Eligible'];
  const type = req.query.type;
  if (!ALLOWED.includes(type)) return res.status(400).json({ error: 'Invalid assignment type' });

  try {
    const p = await db.getPool();
    const r = await timedQuery(p, 'identity-assignments', res, `
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
        WHERE m."identityId" = $1
          AND ra."assignmentType" = $2
        ORDER BY r."displayName", p."displayName"
      `, [identityId, type]);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching identity assignments:', err.message);
    res.status(500).json({ error: 'Failed to fetch identity assignments' });
  }
});

// GET /api/identities/:id/account-matrix
// Per-account data for the matrix "expand identity → accounts" column view:
// the identity's linked accounts plus each account's (resource, membershipType)
// rows from the SAME view the matrix uses, so account sub-columns render cells
// identical to a principal-scoped matrix.
router.get('/identities/:id/account-matrix', async (req, res) => {
  if (!useSql) return res.json({ accounts: [], memberships: [] });
  const identityId = requireValidIdentityId(req, res);
  if (identityId === null) return;
  try {
    const p = await db.getPool();
    const accounts = (await timedQuery(p, 'identity-account-matrix-accounts', res, `
        SELECT m."principalId" AS id,
               COALESCE(pr."displayName", m."displayName") AS "displayName",
               m."accountType" AS "accountType",
               m."isPrimary"   AS "isPrimary"
        FROM "IdentityMembers" m
        LEFT JOIN "Principals" pr ON pr.id = m."principalId"
        WHERE m."identityId" = $1
        ORDER BY m."isPrimary" DESC NULLS LAST, "displayName"
      `, [identityId])).rows;
    const memberships = (await timedQuery(p, 'identity-account-matrix-memberships', res, `
        SELECT vp."principalId"    AS "principalId",
               vp."resourceId"     AS "resourceId",
               vp."membershipType" AS "membershipType"
        FROM "vw_ResourceUserPermissionAssignments" vp
        WHERE vp."principalId" IN (SELECT "principalId" FROM "IdentityMembers" WHERE "identityId" = $1)
      `, [identityId])).rows;
    res.json({ accounts, memberships });
  } catch (err) {
    console.error('Error fetching identity account-matrix:', err.message);
    res.status(500).json({ error: 'Failed to fetch account matrix' });
  }
});

// PUT /api/identities/:id/members/:userId/override — analyst decision on a
// linked account. :userId is the account's principalId. action: confirmed
// (lock the link) | rejected (unlink + keep account linking from re-adding it)
// | moved. The linking engine respects these on re-run.
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
    const memberResult = await timedQuery(p, 'identity-by-user-member', res, `
        SELECT i.id AS "identityId", i."displayName" AS "identityDisplayName", i."accountCount",
          i.email AS "primaryAccountUpn", i."primaryPrincipalId" AS "primaryAccountId",
          i."linkConfidence", i."isHrAnchored",
          m."accountType", m."isPrimary", m."isHrAuthoritative", m."hrScore", m."linkConfidence" AS "memberLinkConfidence",
          m."linkSignals", m."analystOverride"
        FROM "IdentityMembers" m
        JOIN "Identities" i ON i.id = m."identityId"
        WHERE m."principalId" = $1
      `, [userId]);

    if (memberResult.rows.length === 0) {
      return res.json({ identity: null, memberInfo: null });
    }

    const row = memberResult.rows[0];
    const identity = {
      id: row.identityId,
      displayName: row.identityDisplayName,
      accountCount: row.accountCount,
      primaryAccountUpn: row.primaryAccountUpn,
      primaryAccountId: row.primaryAccountId,
      linkConfidence: row.linkConfidence,
      isHrAnchored: row.isHrAnchored,
    };
    const memberInfo = {
      accountType: row.accountType,
      isPrimary: row.isPrimary,
      isHrAuthoritative: row.isHrAuthoritative,
      hrScore: row.hrScore,
      linkConfidence: row.memberLinkConfidence,
      linkSignals: row.linkSignals,
      analystOverride: row.analystOverride,
    };

    // Fetch other accounts in the same identity for context. IdentityMembers
    // stores `principalId` (UUID) — the UPN lives on Principals.email — so we
    // join through and expose the fields the frontend expects (userId / UPN).
    const othersResult = await timedQuery(p, 'identity-by-user-others', res, `
        SELECT m."principalId"        AS "userId",
               COALESCE(m."displayName", pr."displayName") AS "displayName",
               pr."email"             AS "userPrincipalName",
               m."accountType",
               m."isPrimary",
               m."isHrAuthoritative",
               m."accountEnabled"
          FROM "IdentityMembers" m
          LEFT JOIN "Principals" pr ON pr.id = m."principalId"
         WHERE m."identityId" = $1
           AND m."principalId" <> $2
         ORDER BY m."isPrimary" DESC NULLS LAST, m."accountType" ASC
      `, [row.identityId, userId]);

    res.json({ identity, memberInfo, otherMembers: othersResult.rows });
  } catch (err) {
    console.error('Error fetching identity by user:', err.message);
    res.status(500).json({ error: 'Failed to fetch identity' });
  }
});

export default router;
