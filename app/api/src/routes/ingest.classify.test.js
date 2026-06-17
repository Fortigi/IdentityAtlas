// Tests for the classify-business-role-assignments endpoint (T7.9, T7.10).
//
// Covers the XOR dedup fix: for identity rows (principalId IS NULL) the old
// ra2."principalId" = ra."principalId" comparison evaluates NULL=NULL=false,
// so identity Direct rows were never deduped before the subsequent UPDATE hit
// a unique constraint. The fix uses an XOR condition.

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
  it('returns 200 with reclassified and duplicatesRemoved counts (T7.10)', async () => {
    const res = await request(app).post('/ingest/classify-business-role-assignments');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.reclassified).toBe('number');
    expect(typeof res.body.duplicatesRemoved).toBe('number');
  });

  it('dedup DELETE uses XOR condition, not bare principalId comparison (T7.9)', async () => {
    const { sqls } = await captureClassifySql();
    const deleteSql = sqls.find(s => /DELETE FROM "ResourceAssignments"/.test(s)) || '';

    // XOR condition must be present
    expect(deleteSql).toContain('ra."principalId" IS NOT NULL');
    expect(deleteSql).toContain('ra."identityId"  IS NOT NULL');

    // Old bare NULL=NULL comparison must NOT be present — it silently fails for
    // identity rows where principalId IS NULL.
    expect(deleteSql).not.toMatch(/AND ra2\."principalId" = ra\."principalId"/);
  });

  it('dedup DELETE checks both key types in the EXISTS subquery (T7.9)', async () => {
    const { sqls } = await captureClassifySql();
    const deleteSql = sqls.find(s => /DELETE FROM "ResourceAssignments"/.test(s)) || '';

    // The EXISTS subquery must handle principalId-keyed rows
    expect(deleteSql).toContain('ra2."principalId" = ra."principalId"');
    // AND identityId-keyed rows
    expect(deleteSql).toContain('ra2."identityId"  = ra."identityId"');
  });

  it('UPDATE promotion does not restrict by key type (T7.10)', async () => {
    const { sqls } = await captureClassifySql();
    const updateSql = sqls.find(s => /UPDATE "ResourceAssignments"/.test(s)) || '';

    // The UPDATE promotes all remaining Direct rows regardless of whether they
    // carry a principalId or an identityId — resource type is the only filter.
    expect(updateSql).toContain('"assignmentType" = \'Direct\'');
    expect(updateSql).toContain('"assignmentType" = \'Governed\'');
    // Must NOT restrict to principalId IS NOT NULL — that would skip identity rows
    expect(updateSql).not.toContain('principalId IS NOT NULL');
  });
});
