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
