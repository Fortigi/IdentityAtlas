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
// A share is a PROPERTY OF A SAVED MATRIX (#1202, reversing #1166's snapshot
// decision): it points at a `SavedMatrixFilters` row, and that row is the
// single source of truth for the name and the view-state, so recipients always
// see the current saved matrix. Sharing a matrix that isn't saved yet saves and
// shares it in one act, under one name. The share keeps its own at-share-time
// name/filter columns purely as history — they are what the Admin overview
// still shows for a share whose saved matrix was deleted, and what a pre-#1202
// `fgs_…` link resolves to if it was never linked.
//
// New links address the share by its id; only the SHA-256 hash of the old
// `fgs_…` tokens was ever stored, which made "copy the link again later"
// impossible. Both address forms resolve.
//
// The whole surface sits behind the `matrixSharing` feature flag: while it is
// off every route here — resolve included — is a 404, before any permission
// check or database read.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as db from '../../db/connection.js';
import { requirePermission } from '../../middleware/auth.js';
import { isAuthEnabled } from '../../config/authConfig.js';
import { UUID_RE } from '../../matrix/filterSql.js';
import { hashToken, isShareTokenFormat } from '../../auth/shareTokens.js';
import { normalizeRecipients, identityKeysOf, objectIdOf } from './shareRecipients.js';
import { requireFeature } from '../../featureFlags.js';
import { HttpError, insertRecipients, savedMatrixShape } from './shareLinking.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
// Scoped to the share paths: this router is mounted into the shared matrix
// router, so an unscoped router.use() would gate every matrix endpoint.
router.use('/matrix/shares', requireFeature('matrixSharing'));
const canShare = requirePermission('data.share');

// Columns returned to the management page — never the token hash. `name` is
// deliberately absent: where a live saved matrix exists its name wins, so each
// query names the column itself rather than selecting two of them.
const SHARE_COLUMNS =
  's.id, s."shareType", s."filter", s."displayMode", s."managed", s."savedFilterId", ' +
  's."createdBy", s."createdAt", s."revokedAt", s."revokedBy"';

// The saved matrix a share points at, when it still has one.
const SAVED_JOIN = 'LEFT JOIN "SavedMatrixFilters" f ON f.id = s."savedFilterId"';
// The name a share is known by today — the saved matrix's, falling back to the
// at-share-time copy for a legacy or orphaned share.
const LIVE_NAME = 'COALESCE(f."name", s."name") AS "name"';

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

// ─── POST /api/matrix/shares — save + share (data.share) ────────────
//
// Two shapes, one act (#1202):
//   { savedFilterId, recipients }        — share a matrix that is already saved
//   { name, filter, managed, recipients } — save it and share it, one name
//
// Never two names for one thing, and never a silent overwrite: a name that is
// already taken comes back as a 409 the form shows inline.

// A validated saved-matrix id, or null when the caller is sharing an unsaved
// matrix. A malformed id is not treated as "unsaved" — that would silently
// create a second saved matrix for something the caller believed was saved.
function pickSavedFilterId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    throw new HttpError(400, 'savedFilterId must be a saved matrix id');
  }
  return value.trim();
}

// The saved matrix this share is of — looked up, or created from the one name
// the sharer gave. Both branches return the row the share then points at.
async function resolveSavedMatrix(client, { savedFilterId, body, actor }) {
  if (savedFilterId) {
    const found = await client.query(
      `SELECT id, "name", "filter" FROM "SavedMatrixFilters" WHERE id = $1`,
      [savedFilterId],
    );
    if (found.rows.length === 0) throw new HttpError(404, 'Saved matrix not found');
    return found.rows[0];
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!name) throw new HttpError(400, 'name is required');
  if (!body.filter || typeof body.filter !== 'object' || Array.isArray(body.filter)) {
    throw new HttpError(400, 'filter is required');
  }
  const created = await client.query(
    `INSERT INTO "SavedMatrixFilters" (id, "name", "description", "filter", "createdBy", "updatedBy")
     VALUES ($1, $2, NULL, $3, $4, $4)
     RETURNING id, "name", "filter"`,
    [randomUUID(), name, savedMatrixShape(body.filter, pickEnum(body.managed, MANAGED_STATES)), actor],
  );
  return created.rows[0];
}

// A unique-violation is one of two very different things — say which.
function conflictMessage(err, savedName) {
  if (err.constraint === 'ix_MatrixShares_activeSavedFilter') {
    return 'This matrix is already shared. Adjust the people it is shared with instead.';
  }
  return `A saved matrix named "${savedName}" already exists. Pick a different name.`;
}

router.post('/matrix/shares', canShare, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const body = req.body || {};

  // Validated before anything is written, so a request that names nobody can
  // never leave an unreachable share — or a stray saved matrix — behind.
  const recipients = normalizeRecipients(body.recipients);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'Select at least one person to share this matrix with' });
  }

  let savedFilterId;
  try {
    savedFilterId = pickSavedFilterId(body.savedFilterId);
  } catch (err) {
    return res.status(err.status).json({ error: err.message });
  }

  const shareId = randomUUID();
  const actor = actorOf(req);
  let savedName = typeof body.name === 'string' ? body.name.trim() : '';
  try {
    // One transaction: the saved matrix, the share and the people it is
    // addressed to are a single fact. Half of it would be either an unopenable
    // share, an orphaned recipient list, or a matrix saved under a name whose
    // share never came into being.
    const row = await db.tx(async (client) => {
      const saved = await resolveSavedMatrix(client, { savedFilterId, body, actor });
      savedName = saved.name;
      const inserted = await client.query(
        `INSERT INTO "MatrixShares" (id, "shareType", "name", "filter", "displayMode", "managed", "savedFilterId", "createdBy")
         VALUES ($1, 'matrix', $2, $3, $4, $5, $6, $7)
         RETURNING id, "shareType", "name", "filter", "displayMode", "managed", "savedFilterId", "createdBy", "createdAt", "revokedAt", "revokedBy"`,
        [
          shareId, saved.name, saved.filter,
          pickEnum(body.displayMode, DISPLAY_MODES),
          pickEnum(body.managed, MANAGED_STATES),
          saved.id, actor,
        ],
      );
      await insertRecipients(client, shareId, recipients);
      return inserted.rows[0];
    });
    // The link addresses the share by id, so it can be copied again from the
    // matrix, the wizard or Admin at any time — which is the whole point of
    // #1202 and impossible while only a token hash was stored.
    res.status(201).json({ ...row, recipients, shareAddress: row.id });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: conflictMessage(err, savedName) });
    console.error('POST matrix/shares failed:', err.message);
    res.status(500).json({ error: 'Failed to create share' });
  }
});

// ─── PUT /api/matrix/shares/:id/recipients — adjust in place ─────────
//
// The full replacement list. The link is untouched, so "who is this for?" is
// editable without re-minting anything — and because the addressed-to gate
// below reads this table live and fails closed, somebody removed here loses
// access on their very next request.

router.put('/matrix/shares/:id/recipients', canShare, async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const recipients = normalizeRecipients(req.body?.recipients);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'Select at least one person to share this matrix with' });
  }
  try {
    const share = await db.queryOne(
      `SELECT id FROM "MatrixShares" WHERE id = $1 AND "revokedAt" IS NULL`,
      [req.params.id],
    );
    if (!share) return res.status(404).json({ error: 'Share not found' });

    await db.tx(async (client) => {
      // Remove-then-upsert rather than wipe-and-rewrite: somebody who stays on
      // the list keeps the `addedAt` that says since when they had access.
      await client.query(
        `DELETE FROM "MatrixShareRecipients"
          WHERE "shareId" = $1 AND lower("userKey") <> ALL($2::text[])`,
        [req.params.id, recipients.map(r => r.userKey)],
      );
      await insertRecipients(client, req.params.id, recipients);
    });
    res.json({ id: req.params.id, recipients });
  } catch (err) {
    console.error('PUT matrix/shares/:id/recipients failed:', err.message);
    res.status(500).json({ error: 'Failed to update the people this is shared with' });
  }
});

// ─── GET /api/matrix/shares — org-wide list + usage (data.share) ─────

router.get('/matrix/shares', canShare, async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const r = await db.query(`
      SELECT ${SHARE_COLUMNS}, ${LIVE_NAME},
             COALESCE(u."accessCount", 0)::int AS "accessCount",
             COALESCE(u."userCount", 0)::int   AS "userCount",
             u."lastAccessAt",
             COALESCE(u."usage", '[]'::json)   AS "usage",
             COALESCE(rc."recipients", '[]'::json) AS "recipients"
        FROM "MatrixShares" s
        ${SAVED_JOIN}
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
        RETURNING ${SHARE_COLUMNS}, s."name"`,
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

// Which of the two address forms a link carries: a pre-#1202 `fgs_…` token
// (looked up by its stored hash) or a share id (the form every new link uses).
function shareAddress(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (isShareTokenFormat(value)) return { tokenHash: hashToken(value), id: null };
  if (UUID_RE.test(value)) return { tokenHash: null, id: value };
  return null;
}

router.post('/matrix/shares/resolve', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  // A malformed address is indistinguishable from an unknown one on purpose —
  // the recipient sees the same friendly "no longer shared" page either way.
  const address = shareAddress(req.body?.token);
  if (!address) return res.status(404).json({ error: 'Share not found' });

  try {
    const share = await db.queryOne(
      `SELECT ${SHARE_COLUMNS}, ${LIVE_NAME}, f."filter" AS "liveFilter"
         FROM "MatrixShares" s
         ${SAVED_JOIN}
        WHERE ($1::text IS NOT NULL AND s."tokenHash" = $1::text)
           OR ($2::uuid IS NOT NULL AND s.id = $2::uuid)`,
      [address.tokenHash, address.id],
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

    // Live, not frozen (#1202): a linked share answers with the saved matrix as
    // it stands now. Its display mode needs no separate field — the filter's own
    // orientation carries it — and the governed toggle rides in the filter the
    // same way the wizard saves it. A legacy unlinked share still answers with
    // its own snapshot columns, so old links keep showing what they always did.
    const live = share.liveFilter;
    res.json({
      id: share.id,
      shareType: share.shareType,
      name: share.name,
      filter: live || share.filter,
      displayMode: live ? null : share.displayMode,
      managed: (live ? pickEnum(live.managed, MANAGED_STATES) : null) ?? share.managed,
    });
  } catch (err) {
    console.error('POST matrix/shares/resolve failed:', err.message);
    res.status(500).json({ error: 'Failed to open share' });
  }
});

export default router;
