// Contract test — GET /api/matrix/columns?entity=Resource against the real
// PostgreSQL schema.
//
// Guards #928: a Resources column with more than 500 distinct values (e.g.
// `description` in a real tenant) was served as an ARBITRARY 500-value subset.
// `discoverColumnValues` (src/db/columnCache.js) runs
// `SELECT DISTINCT "col" ... LIMIT 500` with NO `ORDER BY` inside the subquery,
// so Postgres is free to return any 500 of the distinct values; the outer
// `ORDER BY col, val` then alphabetises only the survivors. The matrix wizard's
// "+ Attribute" picker therefore shows an alphabetical-looking list with
// unpredictable holes — the reporter's group description exists in the data
// (it shows on the Excel export) but is simply not in the list, while
// alphabetically later descriptions are.
//
// The cap itself lives in SQL, so the mocked-DB unit suite cannot see this —
// it needs a real database with more than 500 distinct values in the column.
//
// The assertion below is deliberately expressed against the EXISTING endpoint
// contract: whatever subset the API serves must be the alphabetically-first
// slice of what is stored, i.e. the list may be short but it may not have
// holes. That is the property a user browsing the list alphabetically relies
// on, and the property the current query violates.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The distinct-value cache in db/columnCache.js is module-level with a 5-minute
// TTL, and contract tests share one process (singleFork). Another file may have
// already warmed it from a different Resources population, which would hide the
// rows seeded here. Reset the module registry so this file boots the app — and
// therefore the cache — fresh.
vi.resetModules();

const { bootContractApp } = await import('../test-utils/contractApp.js');

let agent, pool, systemId;

// 600 distinct descriptions — comfortably past the 500-value cap, so ~100 of
// them must be dropped. Every value shares one prefix and differs only in a
// zero-padded counter, so JS and Postgres agree on their order under any
// collation.
const DESCRIPTIONS = Array.from(
  { length: 600 },
  (_, i) => `#928 contract description ${String(i).padStart(4, '0')}`,
);

// Every distinct, non-empty description currently stored — including any rows
// left by other contract-test files, since the endpoint reports on all of them.
async function storedDescriptions() {
  const r = await pool.query(
    `SELECT DISTINCT "description"::text AS val
       FROM "Resources"
      WHERE "description" IS NOT NULL AND "description"::text <> ''
      ORDER BY val`,
  );
  return r.rows.map(row => row.val);
}

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-column-values-truncation') RETURNING "id"`,
  )).rows[0].id;
  await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "enabled", "description")
     SELECT $1, 'CG-' || d.ord, 'Group', true, d.val
       FROM unnest($2::text[]) WITH ORDINALITY AS d(val, ord)`,
    [systemId, DESCRIPTIONS],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /matrix/columns — a column with more than 500 distinct values (#928)', () => {
  it('serves an alphabetical prefix of the stored values, not an arbitrary subset', async () => {
    const stored = await storedDescriptions();
    expect(stored.length).toBeGreaterThan(500); // fixture sanity

    const res = await agent.get('/api/matrix/columns?entity=Resource');
    expect(res.status).toBe(200);
    const desc = res.body.find(c => c.column === 'description');
    expect(desc).toBeTruthy();

    // The endpoint is allowed to cap the list — it is not allowed to pick an
    // arbitrary slice. RED today: the served values are an unordered subset, so
    // this differs from the alphabetically-first values of the same length.
    expect(desc.values).toEqual(stored.slice(0, desc.values.length));
  });

  it('does not skip stored values that sort before ones it did serve', async () => {
    const stored = await storedDescriptions();

    const res = await agent.get('/api/matrix/columns?entity=Resource');
    const desc = res.body.find(c => c.column === 'description');
    const served = new Set(desc.values);
    const lastServed = desc.values[desc.values.length - 1];

    // The reporter's symptom, stated directly: browsing the list alphabetically,
    // a stored value is missing even though later values are present.
    const holes = stored.filter(v => !served.has(v) && v < lastServed);
    expect(holes).toEqual([]);
  });
});
