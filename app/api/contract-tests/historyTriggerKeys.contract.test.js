// Contract test — fg_record_history() against real PG16.
//
// WHY THIS EXISTS. Migration 022 replaced the audit trigger because the
// composite-PK tables (ResourceAssignments, ResourceRelationships,
// IdentityMembers) have no `id` column, so 009's `rowData->>'id'` keying made
// every change to them vanish instead of being recorded. Migration 071 had to
// CREATE OR REPLACE the same shared function again (to keep profile-photo
// bytes out of the audit log) and its first version was built on 009's body,
// silently reintroducing exactly that bug.
//
// Nothing caught it. The unit mocks are SQL-blind by design (app/api/CLAUDE.md),
// every id-keyed table kept working, and the only symptom was an integration
// assertion about a demo timeline's governed-% trend going flat — three steps
// removed from the cause.
//
// So this pins the function's contract directly, and will fail the next time
// someone replaces it from the wrong starting point:
//   - an id-keyed table is keyed by its id;
//   - each composite-PK table is keyed by its `a|b|c` key;
//   - photo bytes never reach _history, while photoFetchedAt does;
//   - a change to nothing but the photo records no row at all.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';

let pool;
let systemId;

const RES = 'b0000000-0000-0000-0000-0000000h0701';
const PRIN = 'b0000000-0000-0000-0000-0000000h0702';

const histFor = (table, rowId) => pool.query(
  `SELECT "operation", "rowData", "prevData" FROM "_history"
    WHERE "tableName" = $1 AND "rowId" = $2 ORDER BY "changedAt"`,
  [table, rowId],
);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-history-keys') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "_history" WHERE "rowId" LIKE 'b0000000-%' OR "rowId" LIKE '%b0000000-%'`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
});

async function insertPrincipal(extra = {}) {
  const cols = { id: PRIN, systemId, displayName: 'Ada Lovelace', principalType: 'User', ...extra };
  const names = Object.keys(cols).map((c) => `"${c}"`).join(', ');
  const ph = Object.keys(cols).map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(`INSERT INTO "Principals" (${names}) VALUES (${ph})`, Object.values(cols));
}

describe('fg_record_history — row keying', () => {
  it('keys an id-table row by its id', async () => {
    await insertPrincipal();
    const h = await histFor('Principals', PRIN);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].operation).toBe('I');
  });

  it('records a ResourceAssignments insert under its composite key', async () => {
    // THE REGRESSION. With 009's id-only keying this table produces NO history
    // row at all — the audit log goes silent for every assignment change while
    // every other table looks healthy.
    await pool.query(
      `INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES ($1, $2, 'Group A', 'Group')`,
      [RES, systemId],
    );
    await insertPrincipal();
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId")
       VALUES ($1, $2, 'Direct', $3)`,
      [RES, PRIN, systemId],
    );

    const h = await histFor('ResourceAssignments', `${RES}|${PRIN}|Direct`);
    expect(h.rows, 'an assignment insert must be recorded').toHaveLength(1);
    expect(h.rows[0].operation).toBe('I');
    // The flag the demo timeline reconstructs governance from.
    expect(h.rows[0].rowData.governed).toBeDefined();
  });

  it('records a ResourceRelationships insert under its composite key', async () => {
    const child = 'b0000000-0000-0000-0000-0000000h0703';
    for (const [id, name] of [[RES, 'Parent'], [child, 'Child']]) {
      await pool.query(
        `INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES ($1, $2, $3, 'Group')`,
        [id, systemId, name],
      );
    }
    await pool.query(
      `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
       VALUES ($1, $2, 'Contains', $3)`,
      [RES, child, systemId],
    );

    const h = await histFor('ResourceRelationships', `${RES}|${child}|Contains`);
    expect(h.rows).toHaveLength(1);
    await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  });
});

describe('fg_record_history — profile photo', () => {
  it('keeps the photo bytes out of the audit log but keeps the timestamp', async () => {
    const when = '2026-09-01T00:00:00.000Z';
    await insertPrincipal({
      photo: Buffer.from([1, 2, 3]), photoContentType: 'image/jpeg', photoFetchedAt: when,
    });

    const h = await histFor('Principals', PRIN);
    expect(h.rows[0].rowData.photo, 'pixels must not be written to _history').toBeUndefined();
    // The audit value is the fact that a photo changed, not the image.
    expect(h.rows[0].rowData.photoFetchedAt).toBeTruthy();
    expect(h.rows[0].rowData.photoContentType).toBe('image/jpeg');
    // And the rest of the row is still recorded.
    expect(h.rows[0].rowData.displayName).toBe('Ada Lovelace');
  });

  it('records nothing when an update changes only the photo', async () => {
    await insertPrincipal({ photo: Buffer.from([1]) });
    const before = (await histFor('Principals', PRIN)).rows.length;

    await pool.query(`UPDATE "Principals" SET "photo" = $1 WHERE id = $2`, [Buffer.from([9, 9]), PRIN]);

    // A nightly photo refresh must not write one audit row per user.
    expect((await histFor('Principals', PRIN)).rows).toHaveLength(before);
  });

  it('still records an update that changes a real attribute alongside the photo', async () => {
    await insertPrincipal({ photo: Buffer.from([1]) });
    const before = (await histFor('Principals', PRIN)).rows.length;

    await pool.query(
      `UPDATE "Principals" SET "photo" = $1, "department" = 'Engineering' WHERE id = $2`,
      [Buffer.from([7]), PRIN],
    );

    const h = await histFor('Principals', PRIN);
    expect(h.rows).toHaveLength(before + 1);
    const last = h.rows.at(-1);
    expect(last.operation).toBe('U');
    expect(last.rowData.department).toBe('Engineering');
    expect(last.rowData.photo).toBeUndefined();
    expect(last.prevData.photo).toBeUndefined();
  });
});
