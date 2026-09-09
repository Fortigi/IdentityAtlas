// Matrix share links (#1166) — create / list / revoke / resolve.
//
// Mounted by routes/matrix.js via `router.use(...)`, so the public paths are
// /api/matrix/shares[/...] behind the existing authMiddleware mount.
//
// Access model (issue decision D3): the RECIPIENT signs in with their own Entra
// account and reads under their own JWT — the share token is not a credential
// and grants nothing on its own. `resolve` is therefore auth-only (no
// permission gate, same posture as POST /api/matrix/data): on an auth-enabled
// install an anonymous caller can't even resolve a token, and `fgr_` read keys
// can't reach it because they are GET-only. Creating, listing and revoking
// shares is gated on `data.share`.
//
// A share is addressed to NAMED PEOPLE, not to whoever holds the link. The
// sharer picks recipients from the directory and only those accounts (plus the
// sharer themselves) can resolve the token — a forwarded link is useless to
// anyone else. That is why creating a share without a recipient is a 400
// rather than a "public" share: there is no such thing here.
//
// A share stores a SNAPSHOT of the view-state (filter + managed toggle +
// display mode) so later edits to the originating saved filter never change
// what a recipient sees; the underlying data stays live.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as db from '../../db/connection.js';
import { requirePermission } from '../../middleware/auth.js';
import { isAuthEnabled } from '../../config/authConfig.js';
import { UUID_RE } from '../../matrix/filterSql.js';
import { generateShareToken, hashToken, isShareTokenFormat } from '../../auth/shareTokens.js';
import { normalizeRecipients, identityKeysOf, objectIdOf } from './shareRecipients.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const canShare = requirePermission('data.share');

// Columns returned to the management page — never the token hash.
const SHARE_COLUMNS =
  's.id, s."shareType", s."name", s."filter", s."displayMode", s."managed", ' +
  's."createdBy", s."createdAt", s."revokedAt", s."revokedBy"';

// The acting user. Falls back to 'anonymous' rather than 'unknown' because on
// an auth-disabled install there genuinely is no user, and that value is also
// the usage row's key (D6).
function actorOf(req) {
  return (req.user && (req.user.email || req.user.upn || req.user.name)) || 'anonymous';
}

const DISPLAY_MODES = new Set(['grid', 'rotated', 'rollup']);
const MANAGED_STATES = new Set(['all', 'managed', 'unmanaged', 'gaps']);

// Pick an enum-ish snapshot field: an unknown value is dropped rather than
// stored, so a recipient never renders a mode the UI can't honour.
function pickEnum(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

// ─── POST /api/matrix/shares — create (data.share) ──────────────────

router.post('/matrix/shares', canShare, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!body.filter || typeof body.filter !== 'object' || Array.isArray(body.filter)) {
    return res.status(400).json({ error: 'filter is required' });
  }

  // Validated before the share row is written, so a request that names nobody
  // can never leave an unreachable share behind.
  const recipients = normalizeRecipients(body.recipients);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'Select at least one person to share this matrix with' });
  }

  const token = generateShareToken();
  const shareId = randomUUID();
  try {
    // One transaction: the share and the people it is addressed to are a
    // single fact. Half of it would be either an unopenable share or an
    // orphaned recipient list.
    const row = await db.tx(async (client) => {
      const inserted = await client.query(
        `INSERT INTO "MatrixShares" (id, "shareType", "name", "filter", "displayMode", "managed", "tokenHash", "createdBy")
         VALUES ($1, 'matrix', $2, $3, $4, $5, $6, $7)
         RETURNING id, "shareType", "name", "filter", "displayMode", "managed", "createdBy", "createdAt", "revokedAt", "revokedBy"`,
        [
          shareId, name, body.filter,
          pickEnum(body.displayMode, DISPLAY_MODES),
          pickEnum(body.managed, MANAGED_STATES),
          hashToken(token), actorOf(req),
        ],
      );
      const values = recipients.map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`).join(', ');
      await client.query(
        `INSERT INTO "MatrixShareRecipients" ("shareId", "principalId", "userKey", "displayName")
         VALUES ${values}
         ON CONFLICT ("shareId", "userKey") DO NOTHING`,
        [shareId, ...recipients.flatMap(r => [r.principalId, r.userKey, r.displayName])],
      );
      return inserted.rows[0];
    });
    // The plaintext is shown exactly once — only its hash was stored.
    res.status(201).json({ ...row, recipients, token });
  } catch (err) {
    console.error('POST matrix/shares failed:', err.message);
    res.status(500).json({ error: 'Failed to create share' });
  }
});

// ─── GET /api/matrix/shares — org-wide list + usage (data.share) ─────

router.get('/matrix/shares', canShare, async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const r = await db.query(`
      SELECT ${SHARE_COLUMNS},
             COALESCE(u."accessCount", 0)::int AS "accessCount",
             COALESCE(u."userCount", 0)::int   AS "userCount",
             u."lastAccessAt",
             COALESCE(u."usage", '[]'::json)   AS "usage",
             COALESCE(rc."recipients", '[]'::json) AS "recipients"
        FROM "MatrixShares" s
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object(
                   'principalId', r."principalId",
                   'userKey',     r."userKey",
                   'displayName', r."displayName"
                 ) ORDER BY r."displayName" NULLS LAST, r."userKey") AS "recipients"
            FROM "MatrixShareRecipients" r
           WHERE r."shareId" = s.id
        ) rc ON TRUE
        LEFT JOIN LATERAL (
          SELECT SUM(a."accessCount")   AS "accessCount",
                 COUNT(*)               AS "userCount",
                 MAX(a."lastAccessAt")  AS "lastAccessAt",
                 json_agg(json_build_object(
                   'userKey',       a."userKey",
                   'firstAccessAt', a."firstAccessAt",
                   'lastAccessAt',  a."lastAccessAt",
                   'accessCount',   a."accessCount"
                 ) ORDER BY a."lastAccessAt" DESC) AS "usage"
            FROM "MatrixShareAccesses" a
           WHERE a."shareId" = s.id
        ) u ON TRUE
       ORDER BY s."createdAt" DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('GET matrix/shares failed:', err.message);
    res.status(500).json({ error: 'Failed to list shares' });
  }
});

// ─── POST /api/matrix/shares/:id/revoke — soft revoke (data.share) ───

router.post('/matrix/shares/:id/revoke', canShare, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    // COALESCE keeps the first revocation's timestamp and actor, so re-revoking
    // is idempotent instead of rewriting the audit trail.
    const row = await db.queryOne(
      `UPDATE "MatrixShares" s
          SET "revokedAt" = COALESCE(s."revokedAt", now()),
              "revokedBy" = COALESCE(s."revokedBy", $2)
        WHERE s.id = $1
        RETURNING ${SHARE_COLUMNS}`,
      [req.params.id, actorOf(req)],
    );
    if (!row) return res.status(404).json({ error: 'Share not found' });
    res.json(row);
  } catch (err) {
    console.error('POST matrix/shares/:id/revoke failed:', err.message);
    res.status(500).json({ error: 'Failed to revoke share' });
  }
});

// ─── POST /api/matrix/shares/resolve — recipient lookup (auth only) ──
//
// POST (not GET with the token in the path) so the token never lands in a URL,
// a proxy log, or an `fgr_` read key's reach.

// Is this caller one of the people the share was addressed to?
//
// Fails CLOSED: anything other than a positive match on the recipient list (or
// being the sharer) is a no. On an auth-disabled install there is no identity
// to match — the whole deployment is open, so the check is skipped rather than
// locking every recipient out of a link that install can't authenticate.
async function isAddressedTo(share, req) {
  if (!isAuthEnabled()) return true;
  if (share.createdBy && share.createdBy === actorOf(req)) return true;
  const row = await db.queryOne(
    `SELECT 1 AS ok FROM "MatrixShareRecipients"
      WHERE "shareId" = $1
        AND (lower("userKey") = ANY($2::text[])
             OR ($3::uuid IS NOT NULL AND "principalId" = $3::uuid))
      LIMIT 1`,
    [share.id, identityKeysOf(req.user), objectIdOf(req.user)],
  );
  return !!row;
}

router.post('/matrix/shares/resolve', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const token = req.body?.token;
  // A malformed token is indistinguishable from an unknown one on purpose —
  // the recipient sees the same friendly "no longer shared" page either way.
  if (!isShareTokenFormat(token)) return res.status(404).json({ error: 'Share not found' });

  try {
    const share = await db.queryOne(
      `SELECT ${SHARE_COLUMNS} FROM "MatrixShares" s WHERE s."tokenHash" = $1`,
      [hashToken(token)],
    );
    if (!share) return res.status(404).json({ error: 'Share not found' });
    if (share.revokedAt) return res.status(410).json({ error: 'This view is no longer shared' });
    // Not on the guest list: say so plainly, and stamp nothing. The usage log
    // records who OPENED a share, and this caller didn't.
    if (!(await isAddressedTo(share, req))) {
      return res.status(403).json({ error: 'This view was shared with specific people, and you are not one of them' });
    }

    await db.query(
      `INSERT INTO "MatrixShareAccesses" ("shareId", "userKey", "accessCount")
       VALUES ($1, $2, 1)
       ON CONFLICT ("shareId", "userKey") DO UPDATE
         SET "lastAccessAt" = now(),
             "accessCount"  = "MatrixShareAccesses"."accessCount" + 1`,
      [share.id, actorOf(req)],
    );

    res.json({
      id: share.id,
      shareType: share.shareType,
      name: share.name,
      filter: share.filter,
      displayMode: share.displayMode,
      managed: share.managed,
    });
  } catch (err) {
    console.error('POST matrix/shares/resolve failed:', err.message);
    res.status(500).json({ error: 'Failed to open share' });
  }
});

export default router;
