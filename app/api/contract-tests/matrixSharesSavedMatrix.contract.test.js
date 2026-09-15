// Contract test — "a share is a property of a saved matrix" (#1202) against the
// real migration-067 schema.
//
// The unit tests for routes/matrix/shares.js mock the DB, so they prove nothing
// about the SQL or the constraints. This drives the pieces that only real
// PostgreSQL can answer: the migration's backfill of existing shares (including
// the org-wide-unique-name suffixing), the one-live-share-per-matrix partial
// index, the ON DELETE SET NULL that keeps usage history, the dual-address
// resolve, and the saved-filters list's shared/recipientCount aggregate.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { generateShareToken, hashToken } from '../src/auth/shareTokens.js';

let pool;

const FILTER = { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } };
// Every row this file writes is named under this prefix so cleanup can be
// surgical: SavedMatrixFilters is org-wide and shared with other suites.
const PREFIX = 'ctr1202';

// The migration's backfill, executed verbatim. It only touches active, unlinked
// shares, which is exactly what makes it re-runnable — and what lets this test
// drive the real statement instead of a paraphrase of it that could drift.
const MIGRATION = readFileSync(
  fileURLToPath(new URL('../src/db/migrations/067_share_is_a_saved_matrix.sql', import.meta.url)), 'utf8',
);
const BACKFILL = MIGRATION.slice(MIGRATION.indexOf('DO $$'));

// The resolve route's lookup, as routes/matrix/shares.js emits it.
const RESOLVE_SQL = `
  SELECT s.id, s."shareType", s."filter", s."displayMode", s."managed", s."savedFilterId",
         s."createdBy", s."createdAt", s."revokedAt", s."revokedBy",
         COALESCE(f."name", s."name") AS "name", f."filter" AS "liveFilter"
    FROM "MatrixShares" s
    LEFT JOIN "SavedMatrixFilters" f ON f.id = s."savedFilterId"
   WHERE ($1::text IS NOT NULL AND s."tokenHash" = $1::text)
      OR ($2::uuid IS NOT NULL AND s.id = $2::uuid)`;

// The saved-filters list's shared-state aggregate, as routes/matrix/savedFilters.js emits it.
const LIST_SQL = `
  SELECT f.id, f."name",
         (sh.id IS NOT NULL) AS "shared",
         COALESCE(sh."recipientCount", 0)::int AS "recipientCount"
    FROM "SavedMatrixFilters" f
    LEFT JOIN LATERAL (
      SELECT s.id,
             (SELECT COUNT(*) FROM "MatrixShareRecipients" r WHERE r."shareId" = s.id) AS "recipientCount"
        FROM "MatrixShares" s
       WHERE s."savedFilterId" = f.id AND s."revokedAt" IS NULL
       LIMIT 1
    ) sh ON TRUE
   WHERE f."name" LIKE $1
   ORDER BY LOWER(f."name")`;

async function insertSavedMatrix(name, filter = FILTER) {
  const r = await pool.query(
    `INSERT INTO "SavedMatrixFilters" (id, "name", "filter", "createdBy", "updatedBy")
     VALUES ($1, $2, $3, 'analyst@example.com', 'analyst@example.com') RETURNING id, "name"`,
    [randomUUID(), name, filter],
  );
  return r.rows[0];
}

// A pre-#1202 share: its own name, its own frozen snapshot, a token hash, and
// no link to any saved matrix.
async function insertLegacyShare({ name, token, displayMode = null, managed = null, revoked = false }) {
  const r = await pool.query(
    `INSERT INTO "MatrixShares" (id, "shareType", "name", "filter", "displayMode", "managed", "tokenHash", "createdBy", "revokedAt")
     VALUES ($1, 'matrix', $2, $3, $4, $5, $6, 'analyst@example.com', $7)
     RETURNING id, "name", "savedFilterId"`,
    [randomUUID(), name, FILTER, displayMode, managed, hashToken(token), revoked ? new Date() : null],
  );
  return r.rows[0];
}

async function insertLinkedShare(savedFilterId, { name = `${PREFIX} link`, revoked = false } = {}) {
  const r = await pool.query(
    `INSERT INTO "MatrixShares" (id, "shareType", "name", "filter", "savedFilterId", "createdBy", "revokedAt")
     VALUES ($1, 'matrix', $2, $3, $4, 'analyst@example.com', $5)
     RETURNING id`,
    [randomUUID(), name, FILTER, savedFilterId, revoked ? new Date() : null],
  );
  return r.rows[0];
}

async function addRecipients(shareId, keys) {
  for (const key of keys) {
    await pool.query(
      `INSERT INTO "MatrixShareRecipients" ("shareId", "userKey") VALUES ($1, $2)
       ON CONFLICT ("shareId", "userKey") DO NOTHING`,
      [shareId, key],
    );
  }
}

async function cleanup() {
  await pool.query(`DELETE FROM "MatrixShares" WHERE "name" LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM "SavedMatrixFilters" WHERE "name" LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  await cleanup();
  await pool?.end();
});

beforeEach(cleanup);

describe('migration 067 — existing shares become saved matrices', () => {
  it('links an active share to a suffixed saved matrix and keeps its link, recipients and usage', async () => {
    // The clash the migration has to survive: a saved matrix already owns the
    // name this share wants, and saved names are org-wide unique.
    const existing = await insertSavedMatrix(`${PREFIX} Sales team`);
    const token = generateShareToken();
    const share = await insertLegacyShare({
      name: `${PREFIX} Sales team`, token, displayMode: 'rotated', managed: 'gaps',
    });
    await addRecipients(share.id, ['ann@example.com']);
    await pool.query(
      `INSERT INTO "MatrixShareAccesses" ("shareId", "userKey", "accessCount") VALUES ($1, 'ann@example.com', 3)`,
      [share.id],
    );

    await pool.query(BACKFILL);

    const linked = (await pool.query(
      `SELECT s."savedFilterId", s."tokenHash", f."name", f."filter"
         FROM "MatrixShares" s JOIN "SavedMatrixFilters" f ON f.id = s."savedFilterId"
        WHERE s.id = $1`, [share.id],
    )).rows[0];

    // Suffixed, never an overwrite — the existing matrix is somebody's work.
    expect(linked.name).toBe(`${PREFIX} Sales team (2)`);
    expect(linked.savedFilterId).not.toBe(existing.id);
    // The two view-state columns are folded into the filter, the shape the
    // wizard saves: orientation carries 'rotated', `managed` the toggle.
    expect(linked.filter).toEqual({ ...FILTER, orientation: 'rows-as-subjects', managed: 'gaps' });

    // The old link still resolves — by its hash, and now to the live matrix.
    expect(linked.tokenHash).toBe(hashToken(token));
    const resolved = (await pool.query(RESOLVE_SQL, [hashToken(token), null])).rows[0];
    expect(resolved.id).toBe(share.id);
    expect(resolved.name).toBe(`${PREFIX} Sales team (2)`);

    // Recipients and usage are untouched.
    expect((await pool.query(`SELECT 1 FROM "MatrixShareRecipients" WHERE "shareId" = $1`, [share.id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT "accessCount" FROM "MatrixShareAccesses" WHERE "shareId" = $1`, [share.id])).rows[0].accessCount).toBe(3);
  });

  it('drops a stale orientation when the share was a plain grid', async () => {
    const share = await insertLegacyShare({
      name: `${PREFIX} Grid`, token: generateShareToken(), displayMode: 'grid',
    });
    await pool.query(
      `UPDATE "MatrixShares" SET "filter" = $2 WHERE id = $1`,
      [share.id, { ...FILTER, orientation: 'rows-as-subjects' }],
    );

    await pool.query(BACKFILL);

    const filter = (await pool.query(
      `SELECT f."filter" FROM "MatrixShares" s JOIN "SavedMatrixFilters" f ON f.id = s."savedFilterId" WHERE s.id = $1`,
      [share.id],
    )).rows[0].filter;
    expect(filter.orientation).toBeUndefined();
    // No managed column on this share, so none is invented.
    expect(filter.managed).toBeUndefined();
  });

  it('leaves revoked shares as unlinked history, and is safe to run twice', async () => {
    const dead = await insertLegacyShare({ name: `${PREFIX} Dead`, token: generateShareToken(), revoked: true });
    const live = await insertLegacyShare({ name: `${PREFIX} Live`, token: generateShareToken() });

    await pool.query(BACKFILL);
    const firstPass = (await pool.query(
      `SELECT "savedFilterId" FROM "MatrixShares" WHERE id = $1`, [live.id],
    )).rows[0].savedFilterId;
    await pool.query(BACKFILL);

    // A dead link gets no saved matrix — it would only pollute the org-wide list.
    expect((await pool.query(`SELECT "savedFilterId" FROM "MatrixShares" WHERE id = $1`, [dead.id])).rows[0].savedFilterId).toBeNull();
    // And the second pass neither relinked nor duplicated the live one.
    expect((await pool.query(`SELECT "savedFilterId" FROM "MatrixShares" WHERE id = $1`, [live.id])).rows[0].savedFilterId).toBe(firstPass);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM "SavedMatrixFilters" WHERE "name" LIKE $1`, [`${PREFIX} Live%`])).rows[0].n).toBe(1);
  });
});

describe('one live share per saved matrix', () => {
  it('refuses a second live share and allows a new one after a revoke', async () => {
    const saved = await insertSavedMatrix(`${PREFIX} One share`);
    const first = await insertLinkedShare(saved.id);

    await expect(insertLinkedShare(saved.id)).rejects.toMatchObject({
      code: '23505', constraint: 'ix_MatrixShares_activeSavedFilter',
    });

    // Re-sharing after a revoke is a NEW row — hence a new link, as designed.
    await pool.query(`UPDATE "MatrixShares" SET "revokedAt" = now() WHERE id = $1`, [first.id]);
    const second = await insertLinkedShare(saved.id);
    expect(second.id).not.toBe(first.id);
  });

  it('mints no token for a new share — tokenHash is nullable now', async () => {
    const saved = await insertSavedMatrix(`${PREFIX} No token`);
    const share = await insertLinkedShare(saved.id);
    const stored = (await pool.query(`SELECT "tokenHash" FROM "MatrixShares" WHERE id = $1`, [share.id])).rows[0];
    expect(stored.tokenHash).toBeNull();
    // …and the share id alone resolves it.
    expect((await pool.query(RESOLVE_SQL, [null, share.id])).rows[0].id).toBe(share.id);
  });
});

describe('deleting a saved matrix', () => {
  it('keeps the share row and its usage history, orphaning only the pointer', async () => {
    const saved = await insertSavedMatrix(`${PREFIX} Doomed`);
    const share = await insertLinkedShare(saved.id, { name: `${PREFIX} Doomed link` });
    await pool.query(
      `INSERT INTO "MatrixShareAccesses" ("shareId", "userKey", "accessCount") VALUES ($1, 'ann@example.com', 2)`,
      [share.id],
    );

    // What the delete route does, in one transaction.
    await pool.query(
      `UPDATE "MatrixShares" SET "revokedAt" = now(), "revokedBy" = 'admin@example.com'
        WHERE "savedFilterId" = $1 AND "revokedAt" IS NULL`, [saved.id],
    );
    await pool.query(`DELETE FROM "SavedMatrixFilters" WHERE id = $1`, [saved.id]);

    const row = (await pool.query(`SELECT * FROM "MatrixShares" WHERE id = $1`, [share.id])).rows[0];
    expect(row.savedFilterId).toBeNull();                 // ON DELETE SET NULL, not CASCADE
    expect(row.revokedAt).not.toBeNull();                 // so the link is closed, not dangling
    expect(row.name).toBe(`${PREFIX} Doomed link`);       // Admin still knows what it was
    expect((await pool.query(`SELECT 1 FROM "MatrixShareAccesses" WHERE "shareId" = $1`, [share.id])).rowCount).toBe(1);
  });
});

describe('resolve returns the live saved matrix', () => {
  it('follows a later edit instead of the frozen snapshot', async () => {
    const saved = await insertSavedMatrix(`${PREFIX} Live view`);
    const share = await insertLinkedShare(saved.id);

    await pool.query(
      `UPDATE "SavedMatrixFilters" SET "name" = $2, "filter" = $3 WHERE id = $1`,
      [saved.id, `${PREFIX} Renamed view`, { ...FILTER, rowType: 'identity', managed: 'managed' }],
    );

    const row = (await pool.query(RESOLVE_SQL, [null, share.id])).rows[0];
    expect(row.name).toBe(`${PREFIX} Renamed view`);
    expect(row.liveFilter).toEqual({ ...FILTER, rowType: 'identity', managed: 'managed' });
    // The frozen copy is still on the row — it is history, not what is served.
    expect(row.filter).toEqual(FILTER);
  });
});

describe('saved-filters list carries shared state', () => {
  it('counts recipients of the live share only', async () => {
    const shared = await insertSavedMatrix(`${PREFIX} A shared`);
    const wasShared = await insertSavedMatrix(`${PREFIX} B revoked`);
    await insertSavedMatrix(`${PREFIX} C never`);

    const live = await insertLinkedShare(shared.id, { name: `${PREFIX} live link` });
    await addRecipients(live.id, ['ann@example.com', 'bob@example.com']);
    const dead = await insertLinkedShare(wasShared.id, { name: `${PREFIX} dead link`, revoked: true });
    await addRecipients(dead.id, ['carl@example.com']);

    const rows = (await pool.query(LIST_SQL, [`${PREFIX}%`])).rows;
    expect(rows.map(r => [r.name, r.shared, r.recipientCount])).toEqual([
      [`${PREFIX} A shared`, true, 2],
      // A revoked share must not leave a matrix reading as still shared.
      [`${PREFIX} B revoked`, false, 0],
      [`${PREFIX} C never`, false, 0],
    ]);
  });
});
