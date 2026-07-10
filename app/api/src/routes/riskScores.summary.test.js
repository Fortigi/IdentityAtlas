// Tests for the risk-dashboard summary endpoint (GET /risk-scores):
//  - the "top N" queries stay bounded (the UI only shows a few, so these must
//    not fetch/sort every risk-scored row),
//  - the tier/totals aggregation builds the summary object, and
//  - the failure paths (whole-summary 500, swallowed resource-type breakdown).
//
// Mocks the DB layer so each query's SQL/label is captured and its result (or a
// thrown error) can be scripted per label.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.USE_SQL = 'true'; // module loads its db import + useSql at eval time

const captured = [];
// Per-label response overrides: an array becomes the recordset; an Error is thrown.
let responses = {};
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: (_p, label) => ({
    input() { return this; },
    query: async (sql) => {
      captured.push({ label, sql });
      // riskTableExists must see the table so the handler reaches the top-N queries.
      if (label === 'risk-table-check') return { recordset: [{ tbl: 'public.RiskScores' }] };
      const r = responses[label];
      if (r instanceof Error) throw r;
      return { recordset: r ?? [] };
    },
  }),
}));
vi.mock('../db/connection.js', () => ({ getPool: async () => ({}), query: async () => ({ rows: [] }), queryOne: async () => null }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, n) => n() }));
vi.mock('../db/queryHelpers.js', () => ({ queryRiskScoresPage: async () => ({ data: [], total: 0 }) }));

const { default: riskScoresRouter } = await import('./riskScores.js');
const app = express().use(express.json()).use(riskScoresRouter);

const sqlFor = (label) => captured.find(c => c.label === label)?.sql || '';

beforeEach(() => { captured.length = 0; responses = {}; });

describe('GET /risk-scores summary', () => {
  it('caps top users/resources at LIMIT 10 and scored-at at LIMIT 1', async () => {
    const res = await request(app).get('/risk-scores');
    expect(res.status).toBe(200);
    expect(sqlFor('risk-top-users')).toMatch(/LIMIT\s+10/);
    expect(sqlFor('risk-top-resources')).toMatch(/LIMIT\s+10/);
    expect(sqlFor('risk-scored-at')).toMatch(/LIMIT\s+1\b/);
  });

  it('aggregates tier distribution and totals into the summary object', async () => {
    responses = {
      'risk-tier-distribution': [
        { entityType: 'Principal', riskTier: 'High', count: 3 },
        { entityType: 'Resource',  riskTier: null,   count: 2 }, // null tier → 'None'
      ],
      'risk-totals': [{ entityType: 'Principal', total: 5, overrides: 1 }],
      'risk-top-users':     [{ riskScore: 90 }],
      'risk-top-resources': [{ riskScore: 80 }],
      'risk-resource-types': [{ resourceType: 'Group', count: 4, avgScore: 50 }],
      'risk-scored-at':     [{ riskScoredAt: '2026-01-01T00:00:00Z' }],
    };
    const res = await request(app).get('/risk-scores');
    expect(res.status).toBe(200);
    expect(res.body.summary.usersByTier).toEqual({ High: 3 });
    expect(res.body.summary.groupsByTier).toEqual({ None: 2 });
    expect(res.body.summary.totalUsers).toBe(5);
    expect(res.body.summary.userOverrides).toBe(1);
    expect(res.body.summary.resourceTypeBreakdown).toEqual([{ resourceType: 'Group', count: 4, avgScore: 50 }]);
    expect(res.body.scoredAt).toBe('2026-01-01T00:00:00Z');
  });

  it('nulls resourceTypeBreakdown when its query fails (swallowed)', async () => {
    responses = { 'risk-resource-types': new Error('no perms on Resources') };
    const res = await request(app).get('/risk-scores');
    expect(res.status).toBe(200);
    expect(res.body.summary.resourceTypeBreakdown).toBeNull();
  });

  it('returns 500 when a summary query fails', async () => {
    responses = { 'risk-tier-distribution': new Error('db down') };
    const res = await request(app).get('/risk-scores');
    expect(res.status).toBe(500);
  });
});
