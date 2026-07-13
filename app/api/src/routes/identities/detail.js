// Identity detail endpoints — /api/identities/:id and its sub-resources
// (contexts, assignments, account-matrix) plus /api/identities/by-user/:userId.
//
// Extracted verbatim from routes/identities.js (audit finding C1). Mounted by
// routes/identities.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { timedRequest } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { useSql, db, UUID_RE, hasTable, enrichMembers } from './shared.js';

const router = Router();

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

    // Fetch all member accounts from Principals (v5). IdentityMembers stores
    // displayName opportunistically; many rows have null there so we coalesce
    // with the Principals record and pull UPN out of Principals.email (v5 has
    // no separate userPrincipalName column).
    const membersResult = await timedRequest(p, 'identity-members', res)
      .input('identityId', identityId)
      .query(`
          SELECT m."identityId", m."principalId", m."isPrimary", m."isHrAuthoritative",
                 m."accountType", m."accountTypePattern", m."accountEnabled",
                 m."linkSignals", m."linkConfidence", m."hrScore",
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

    // Enrich members with risk scores (optional).
    let riskRows = [];
    try {
      const riskResult = await timedRequest(p, 'identity-member-risks', res)
        .input('identityId', identityId)
        .query(`
            SELECT m."principalId", u."riskScore", u."riskTier"
            FROM "IdentityMembers" m
            LEFT JOIN "Principals" u ON m."principalId" = u.id
            WHERE m."identityId" = @identityId
          `);
      riskRows = riskResult.recordset;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* risk columns may not exist yet */ }

    // Fetch group memberships per account for context
    let groupCountRows = [];
    try {
      const groupCountResult = await timedRequest(p, 'identity-member-groups', res)
        .input('identityId', identityId)
        .query(`
          SELECT m."principalId", COUNT(DISTINCT gm."resourceId")::int AS "groupCount"
          FROM "IdentityMembers" m
          LEFT JOIN "ResourceAssignments" gm ON m."principalId" = gm."principalId" AND gm."assignmentType" = 'Direct'
          WHERE m."identityId" = @identityId
          GROUP BY m."principalId"
        `);
      groupCountRows = groupCountResult.recordset;
    } catch (e) {
      if (!isMissingSchema(e)) throw e;  // ResourceAssignments may not exist
    }

    // Attach per-account group counts + risk (keyed by principalId — see enrichMembers).
    enrichMembers(membersResult.recordset, riskRows, groupCountRows);

    // Aggregate relationship counts across every linked account — the entity
    // graph shows these as nodes ("32 groups across 3 accounts", "4 access
    // packages"). One query joins IdentityMembers to ResourceAssignments and
    // groups by assignmentType so we stay cheap.
    const aggregate = { Direct: 0, Governed: 0, Owner: 0, Eligible: 0, OAuth2Grant: 0 };
    try {
      const aggResult = await timedRequest(p, 'identity-aggregate-counts', res)
        .input('identityId', identityId)
        .query(`
          SELECT CASE WHEN gov."governanceResource" THEN 'Governed' ELSE ra."assignmentType" END AS "assignmentType",
                 COUNT(DISTINCT ra."resourceId")::int AS cnt
          FROM "IdentityMembers" m
          JOIN "ResourceAssignments" ra ON ra."principalId" = m."principalId"
          LEFT JOIN "Resources" gov ON gov.id = ra."resourceId"
          WHERE m."identityId" = @identityId
          GROUP BY 1
        `);
      for (const row of aggResult.recordset) {
        if (row.assignmentType in aggregate) aggregate[row.assignmentType] = row.cnt;
      }
    } catch (e) { if (!isMissingSchema(e)) throw e; /* ResourceAssignments may not exist */ }

    // An identity belongs to a context either as an Identity member directly, or
    // through any of its linked principals (Principal-targeted contexts like Tags
    // store the principal, not the identity). The old query only checked the
    // Identity path — of which there are typically none — so it always read 0.
    let contextCount = 0;
    try {
      const r = await timedRequest(p, 'identity-context-count', res)
        .input('identityId', identityId)
        .query(`SELECT COUNT(DISTINCT cm."contextId")::int AS cnt
                  FROM "ContextMembers" cm
                 WHERE (cm."memberType" = 'Identity'  AND cm."memberId"::text = @identityId)
                    OR (cm."memberType" = 'Principal' AND cm."memberId"::text IN (
                          SELECT im."principalId"::text FROM "IdentityMembers" im
                           WHERE im."identityId"::text = @identityId))`);
      contextCount = r.recordset[0]?.cnt || 0;
    } catch (e) { if (!isMissingSchema(e)) throw e; /* ContextMembers may not exist */ }

    res.json({
      identity,
      members: membersResult.recordset,
      aggregateAssignments: aggregate,
      contextCount,
    });
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
    const r = await timedRequest(p, 'identity-contexts', res)
      .input('identityId', req.params.id)
      .query(`SELECT DISTINCT ON (c.id) c.id, c."displayName", c."contextType",
                     c."targetType", c.variant
                FROM "ContextMembers" cm
                JOIN "Contexts" c ON c.id = cm."contextId"
               WHERE (cm."memberType" = 'Identity'  AND cm."memberId"::text = @identityId)
                  OR (cm."memberType" = 'Principal' AND cm."memberId"::text IN (
                        SELECT im."principalId"::text FROM "IdentityMembers" im
                         WHERE im."identityId"::text = @identityId))
               ORDER BY c.id, c."contextType", c."displayName"`);
    res.json(r.recordset);
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
  const identityId = req.params.id;
  if (!UUID_RE.test(identityId)) return res.status(400).json({ error: 'Invalid identity ID' });
  const ALLOWED = ['Direct', 'Indirect', 'Eligible'];
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

// GET /api/identities/:id/account-matrix
// Per-account data for the matrix "expand identity → accounts" column view:
// the identity's linked accounts plus each account's (resource, membershipType)
// rows from the SAME view the matrix uses, so account sub-columns render cells
// identical to a principal-scoped matrix.
router.get('/identities/:id/account-matrix', async (req, res) => {
  if (!useSql) return res.json({ accounts: [], memberships: [] });
  const identityId = req.params.id;
  if (!UUID_RE.test(identityId)) return res.status(400).json({ error: 'Invalid identity ID' });
  try {
    const p = await db.getPool();
    const accounts = (await timedRequest(p, 'identity-account-matrix-accounts', res)
      .input('id', identityId)
      .query(`
        SELECT m."principalId" AS id,
               COALESCE(pr."displayName", m."displayName") AS "displayName",
               m."accountType" AS "accountType",
               m."isPrimary"   AS "isPrimary"
        FROM "IdentityMembers" m
        LEFT JOIN "Principals" pr ON pr.id = m."principalId"
        WHERE m."identityId" = @id
        ORDER BY m."isPrimary" DESC NULLS LAST, "displayName"
      `)).recordset;
    const memberships = (await timedRequest(p, 'identity-account-matrix-memberships', res)
      .input('id', identityId)
      .query(`
        SELECT vp."principalId"    AS "principalId",
               vp."resourceId"     AS "resourceId",
               vp."membershipType" AS "membershipType"
        FROM "vw_ResourceUserPermissionAssignments" vp
        WHERE vp."principalId" IN (SELECT "principalId" FROM "IdentityMembers" WHERE "identityId" = @id)
      `)).recordset;
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
    const memberResult = await timedRequest(p, 'identity-by-user-member', res)
      .input('userId', userId)
      .query(`
        SELECT i.id AS "identityId", i."displayName" AS "identityDisplayName", i."accountCount",
          i.email AS "primaryAccountUpn", i."primaryPrincipalId" AS "primaryAccountId",
          i."linkConfidence", i."isHrAnchored",
          m."accountType", m."isPrimary", m."isHrAuthoritative", m."hrScore", m."linkConfidence" AS "memberLinkConfidence",
          m."linkSignals", m."analystOverride"
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
    const othersResult = await timedRequest(p, 'identity-by-user-others', res)
      .input('identityId', row.identityId)
      .input('userId', userId)
      .query(`
        SELECT m."principalId"        AS "userId",
               COALESCE(m."displayName", pr."displayName") AS "displayName",
               pr."email"             AS "userPrincipalName",
               m."accountType",
               m."isPrimary",
               m."isHrAuthoritative",
               m."accountEnabled"
          FROM "IdentityMembers" m
          LEFT JOIN "Principals" pr ON pr.id = m."principalId"
         WHERE m."identityId" = @identityId
           AND m."principalId" <> @userId
         ORDER BY m."isPrimary" DESC NULLS LAST, m."accountType" ASC
      `);

    res.json({ identity, memberInfo, otherMembers: othersResult.recordset });
  } catch (err) {
    console.error('Error fetching identity by user:', err.message);
    res.status(500).json({ error: 'Failed to fetch identity' });
  }
});

export default router;
