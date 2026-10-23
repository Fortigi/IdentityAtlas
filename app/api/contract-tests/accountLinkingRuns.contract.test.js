// Contract test — the AccountLinkingRuns row shape account linking actually writes,
// against real PostgreSQL.
//
// The unit tests for the engine mock the database and are SQL-blind: they assert that
// `nameOnlyMatches`, `linksRemoved` and `nameOnlySuggestions` are in the UPDATE, not that
// the columns exist or accept those values. A missing migration, a typo in a quoted
// identifier, or a JSONB column fed a JS array would pass every one of them and fail only
// at runtime — where the run is fire-and-forget, so the failure lands in a log nobody is
// watching and the UI simply shows no suggestions.
//
// So this file writes a run row the way the engine writes one (same column names, same
// value types including the JSON.stringify'd suggestions document), reads it back, and
// asserts the round trip. It also pins NULL-ability: a pre-092 run must stay reportable
// as "not measured" rather than as zero.
//
// Isolation on the shared contract DB: every row this file inserts is deleted in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

let pool;
const runIds = [];

const SUGGESTION = {
  principalId: 'p-namesake',
  displayName: 'Doe, John',
  identityId: 'i-john',
  identityName: 'John Doe',
  confidence: 60,
  signals: ['fullName'],
  accountType: 'Secondary',
  ties: 2,
};

/** Insert a run row with exactly the columns runLinking's completion UPDATE writes. */
async function insertRun(fields = {}) {
  const { rows } = await pool.query(`
    INSERT INTO "AccountLinkingRuns"
      ("status", "step", "pct", "candidatesScanned", "linksCreated", "linksUpdated",
       "skippedAnalystOverride", "orphansRemaining", "triggeredBy",
       "nameOnlyMatches", "linksRemoved", "nameOnlySuggestions")
    VALUES ('completed', 'Done', 100, 12, 1, 0, 0, 11, 'contract-test', $1, $2, $3)
    RETURNING *
  `, [fields.nameOnlyMatches ?? null, fields.linksRemoved ?? null, fields.nameOnlySuggestions ?? null]);
  runIds.push(rows[0].id);
  return rows[0];
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterAll(async () => {
  if (runIds.length) {
    await pool.query(`DELETE FROM "AccountLinkingRuns" WHERE id = ANY($1::bigint[])`, [runIds]);
  }
  await pool?.end();
});

describe('AccountLinkingRuns — name-only reporting columns', () => {
  it('round-trips the counts and the suggestions document the engine writes', async () => {
    // JSON.stringify is what runLinking passes for the JSONB column; node-postgres parses
    // it back into a JS value, so the read side must get objects, not a string.
    const row = await insertRun({
      nameOnlyMatches: 3,
      linksRemoved: 2,
      nameOnlySuggestions: JSON.stringify([SUGGESTION]),
    });

    expect(row.nameOnlyMatches).toBe(3);
    expect(row.linksRemoved).toBe(2);
    expect(row.nameOnlySuggestions).toEqual([SUGGESTION]);
    // The signals list survives as a list — the UI renders it as one badge per signal.
    expect(row.nameOnlySuggestions[0].signals).toEqual(['fullName']);
  });

  it('stores an empty suggestions list distinctly from NULL', async () => {
    const looked = await insertRun({ nameOnlyMatches: 0, linksRemoved: 0, nameOnlySuggestions: '[]' });
    const preFeature = await insertRun();

    expect(looked.nameOnlySuggestions).toEqual([]);
    expect(looked.nameOnlyMatches).toBe(0);
    // A run that predates the feature carries no answer at all, which is what lets the UI
    // omit the clause instead of claiming zero name-only matches were found.
    expect(preFeature.nameOnlySuggestions).toBeNull();
    expect(preFeature.nameOnlyMatches).toBeNull();
    expect(preFeature.linksRemoved).toBeNull();
  });

  it('serves the new columns through the same runs query the API uses', async () => {
    // routes/accountLinking.js does `SELECT *`, so the columns reach the client with no
    // route change — this asserts that is actually true of the real table.
    const inserted = await insertRun({ nameOnlyMatches: 5, linksRemoved: 1, nameOnlySuggestions: '[]' });
    const { rows } = await pool.query(
      `SELECT * FROM "AccountLinkingRuns" WHERE id = $1 ORDER BY "startedAt" DESC LIMIT 50`, [inserted.id]);

    expect(rows[0]).toMatchObject({ nameOnlyMatches: 5, linksRemoved: 1, nameOnlySuggestions: [] });
  });
});
