// Tests for the classify-business-role-assignments endpoint.
//
// In the governed-as-IGA-flag model the endpoint flags memberships in a
// governance resource (governanceResource=true) as governed=true — flat
// importers (CSV) don't know which resources are governance resources at
// assignment-import time. The provisioning gap is derived in the matrix
// matview, so there is no Direct→Governed promotion and no dedup DELETE here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Module mocks (hoisted so they are in scope before any imports) ────────────

const { mockQuery } = vi.hoisted(() => {
  process.env.USE_SQL = 'true';
  const mockQuery = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
  return { mockQuery };
});

vi.mock('../db/connection.js', () => ({
  query:    mockQuery,
  queryOne: vi.fn().mockResolvedValue(null),
  getPool:  vi.fn().mockResolvedValue({ query: mockQuery }),
  tx:       vi.fn(async (fn) => fn({ query: mockQuery })),
}));

vi.mock('../middleware/crawlerAuth.js', () => ({
  crawlerHasPermission:   vi.fn().mockReturnValue(true),
  crawlerHasSystemAccess: vi.fn().mockReturnValue(true),
}));

const { default: ingestRouter } = await import('./ingest.js');
const app = express().use(express.json()).use(ingestRouter);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect all SQL strings passed to db.query during a single request. */
async function captureClassifySql() {
  const sqls = [];
  mockQuery.mockImplementation(async (sql) => {
    sqls.push(typeof sql === 'string' ? sql : '');
    return { rowCount: 0, rows: [] };
  });
  const res = await request(app).post('/ingest/classify-business-role-assignments');
  return { res, sqls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /ingest/classify-business-role-assignments', () => {
  it('returns 200 with a governedMarked count', async () => {
    const res = await request(app).post('/ingest/classify-business-role-assignments');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.governedMarked).toBe('number');
  });

  it('flags governance-resource memberships as governed=true', async () => {
    const { sqls } = await captureClassifySql();
    const updateSql = sqls.find(s => /UPDATE "ResourceAssignments"/.test(s)) || '';
    expect(updateSql).toContain('SET "governed" = true');
    expect(updateSql).toContain('r."governanceResource"');
    expect(updateSql).toContain('ra."governed" = false');
  });

  it('does not promote to a Governed assignmentType and does not delete rows', async () => {
    const { sqls } = await captureClassifySql();
    const joined = sqls.join('\n');
    expect(joined).not.toContain("'Governed'");
    expect(joined).not.toMatch(/DELETE FROM "ResourceAssignments"/);
  });
});

// ── Matrix matview refresh (regression: #1162's sibling, #1047) ───────────────
//
// The endpoint's whole point is that the UI sees fresh data afterwards, and for
// a while it silently didn't: `refreshMatrixViews` was called but never imported
// into handlers.js, so the call threw a ReferenceError that the "non-critical"
// try/catch swallowed. The endpoint still answered 200 with a plausible
// governedMarked count, and every test above still passed — none of them looked
// at viewRefresh.
//
// So these assert the WORK, not the label: that the REFRESH statements actually
// reached the database. A regression that hardcoded viewRefresh:'ok' without
// refreshing anything would pass a status check and fail these.
describe('POST /ingest/classify-business-role-assignments — matview refresh', () => {
  const MATVIEWS = [
    'vw_ResourceUserPermissionAssignments',
    'vw_UserPermissionAssignmentViaBusinessRole',
  ];

  it('refreshes both matrix materialized views', async () => {
    const { sqls } = await captureClassifySql();
    const refreshes = sqls.filter(s => /REFRESH MATERIALIZED VIEW/.test(s));
    expect(refreshes).toHaveLength(MATVIEWS.length);
    for (const view of MATVIEWS) {
      expect(
        refreshes.some(s => s.includes(`"${view}"`)),
        `no REFRESH MATERIALIZED VIEW issued for ${view}`,
      ).toBe(true);
    }
  });

  it('reports viewRefresh: "ok" when the refresh succeeds', async () => {
    const res = await request(app).post('/ingest/classify-business-role-assignments');
    expect(res.status).toBe(200);
    expect(res.body.viewRefresh).toBe('ok');
  });

  it('refreshes AFTER the governed UPDATE, not before', async () => {
    // Refreshing first would materialise the pre-classify state and leave the
    // UI exactly as stale as it was — the bug's symptom, from a different cause.
    const { sqls } = await captureClassifySql();
    const updateAt  = sqls.findIndex(s => /UPDATE "ResourceAssignments"/.test(s));
    const refreshAt = sqls.findIndex(s => /REFRESH MATERIALIZED VIEW/.test(s));
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(refreshAt).toBeGreaterThan(updateAt);
  });

  it('reports viewRefresh: "failed" — and still 200 — when the refresh throws', async () => {
    // The classify UPDATE has already committed by then, so a refresh failure
    // must not fail the request. This path stays swallowed ON PURPOSE; what the
    // bug proved is that it must never be reachable by a *programming* error.
    mockQuery.mockImplementation(async (sql) => {
      if (/REFRESH MATERIALIZED VIEW/.test(sql)) throw new Error('deadlock detected');
      return { rowCount: 0, rows: [] };
    });
    const res = await request(app).post('/ingest/classify-business-role-assignments');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.viewRefresh).toBe('failed');
  });
});
