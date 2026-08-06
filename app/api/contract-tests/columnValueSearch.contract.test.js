// Contract test — GET /api/matrix/column-values against the real PostgreSQL
// schema.
//
// The companion of columnValuesTruncation.contract.test.js: that one pins that
// the preloaded value page is the alphabetical prefix of what is stored, this
// one pins that the values OUTSIDE that page are still reachable. Together they
// close #928 — the reporter's group description existed in the data but could
// not be picked in the matrix wizard, because discovery served an arbitrary
// page and offered no way to search past it.
//
// The search SQL (strpos on the lower-cased pair, JSON-path form for ext.<key>)
// only runs against a real database, so a mocked-DB unit test cannot prove it.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Module-level caches with a 5-minute TTL + a shared process (singleFork): boot
// this file's app fresh so the values discovered here reflect the rows seeded
// here.
vi.resetModules();

const { bootContractApp } = await import('../test-utils/contractApp.js');

let agent, pool, systemId;

// One value sorting past the preloaded page (600 fillers > the 500 cap), the
// reporter's case exactly: stored, exported, but off the end of the list.
const TARGET = 'Zzz — the description the wizard could not find (#928)';
const FILLERS = Array.from(
  { length: 600 },
  (_, i) => `#928 searchable description ${String(i).padStart(4, '0')}`,
);

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-column-value-search') RETURNING "id"`,
  )).rows[0].id;
  await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "enabled", "description", "extendedAttributes")
     SELECT $1, 'CS-' || d.ord, 'Group', true, d.val, jsonb_build_object('costCenter', 'CC-' || d.ord)
       FROM unnest($2::text[]) WITH ORDINALITY AS d(val, ord)`,
    [systemId, [...FILLERS, TARGET]],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /matrix/column-values (#928)', () => {
  it('finds a value that does not fit in the preloaded page', async () => {
    const preload = await agent.get('/api/matrix/columns?entity=Resource');
    const desc = preload.body.find(c => c.column === 'description');
    expect(desc.truncated).toBe(true);
    expect(desc.values).not.toContain(TARGET);

    const res = await agent.get(
      `/api/matrix/column-values?entity=Resource&column=description&q=${encodeURIComponent('could not find')}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.values).toContain(TARGET);
  });

  it('matches case-insensitively on a substring, not just a prefix', async () => {
    const res = await agent.get(
      '/api/matrix/column-values?entity=Resource&column=description&q=SEARCHABLE%20description%200123',
    );
    expect(res.status).toBe(200);
    expect(res.body.values).toContain('#928 searchable description 0123');
  });

  it('searches an ext.<key> through the JSON path', async () => {
    const res = await agent.get(
      '/api/matrix/column-values?entity=Resource&column=ext.costCenter&q=CC-42',
    );
    expect(res.status).toBe(200);
    expect(res.body.values).toContain('CC-42');
  });

  it('treats SQL wildcards in the search term as literal characters', async () => {
    const res = await agent.get(
      '/api/matrix/column-values?entity=Resource&column=description&q=%25%25%25',
    );
    expect(res.status).toBe(200);
    expect(res.body.values).toEqual([]);
  });

  it('rejects a column that was never discovered', async () => {
    const res = await agent.get(
      '/api/matrix/column-values?entity=Resource&column=nope&q=x',
    );
    expect(res.status).toBe(400);
  });
});
