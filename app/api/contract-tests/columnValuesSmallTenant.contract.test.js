// Contract test — the #928 capped-value path on a dataset far below the
// default 500-value cap.
//
// The companion truncation/search contract tests seed 600 descriptions to get
// past the default page size. A real test deployment usually holds a few
// hundred resources, which means the capped path — the one that made the
// reporter's group description unreachable — never triggers there and cannot be
// verified by hand.
//
// MATRIX_VALUE_PAGE_SIZE lowers the page size, so the same behaviour is
// reproducible on any dataset: this file seeds a dozen descriptions, sets the
// page to 5, and asserts the full reporter path — a flagged alphabetical page,
// nothing served out of order, and every value past the page still findable
// through the search endpoint. It is also the recipe documented in
// docs/architecture/matrix.md for testing on a small tenant.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Module-level value caches with a 5-minute TTL + a shared process (singleFork):
// boot this file's app fresh so discovery reflects this file's rows and this
// file's page size.
vi.resetModules();

const { bootContractApp } = await import('../test-utils/contractApp.js');
const { clearColumnCaches } = await import('../src/db/columnCache.js');

const PAGE_SIZE = 5;
const originalPageSize = process.env.MATRIX_VALUE_PAGE_SIZE;

let agent, pool, systemId;

// Twelve descriptions — a fifth of a percent of what the default cap needs, but
// more than twice the lowered page size. The shared prefix + zero-padded counter
// keeps JS and Postgres ordering identical under any collation.
const DESCRIPTIONS = Array.from(
  { length: 12 },
  (_, i) => `#928 small-tenant description ${String(i).padStart(2, '0')}`,
);

// Every distinct, non-empty description currently stored — other contract files
// share the database, and the endpoint reports on all of their rows too.
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
  process.env.MATRIX_VALUE_PAGE_SIZE = String(PAGE_SIZE);
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-column-values-small-tenant') RETURNING "id"`,
  )).rows[0].id;
  await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "enabled", "description")
     SELECT $1, 'ST-' || d.ord, 'Group', true, d.val
       FROM unnest($2::text[]) WITH ORDINALITY AS d(val, ord)`,
    [systemId, DESCRIPTIONS],
  );
  clearColumnCaches();
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  clearColumnCaches();
  // singleFork — env mutations leak across files.
  if (originalPageSize === undefined) delete process.env.MATRIX_VALUE_PAGE_SIZE;
  else process.env.MATRIX_VALUE_PAGE_SIZE = originalPageSize;
  delete process.env.USE_SQL;
});

describe('#928 verification on a dataset smaller than the default cap', () => {
  it('caps at the configured page size and says so', async () => {
    const stored = await storedDescriptions();
    expect(stored.length).toBeGreaterThan(PAGE_SIZE);
    expect(stored.length).toBeLessThan(500); // the point of the fixture

    const res = await agent.get('/api/matrix/columns?entity=Resource');
    expect(res.status).toBe(200);
    const desc = res.body.find(c => c.column === 'description');

    expect(desc.values).toHaveLength(PAGE_SIZE);
    expect(desc.truncated).toBe(true);
    // The served page is the alphabetical prefix — the reporter's symptom was
    // exactly this list having holes.
    expect(desc.values).toEqual(stored.slice(0, PAGE_SIZE));
  });

  it('still finds a value that sorts past the page', async () => {
    const stored = await storedDescriptions();
    const target = stored[stored.length - 1];

    const preload = await agent.get('/api/matrix/columns?entity=Resource');
    expect(preload.body.find(c => c.column === 'description').values).not.toContain(target);

    const res = await agent.get(
      `/api/matrix/column-values?entity=Resource&column=description&q=${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.values).toContain(target);
  });
});
