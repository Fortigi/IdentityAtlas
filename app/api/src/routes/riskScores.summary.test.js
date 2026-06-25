// Guards that the risk-dashboard summary endpoint bounds its "top N" queries.
//
// The UI shows only the top few, so these queries must not fetch/sort every
// risk-scored row. Mocks the DB layer to capture each query's SQL and asserts
// the LIMITs are present.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.USE_SQL = 'true'; // module loads its db import + useSql at eval time

const captured = [];
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: (_p, label) => ({
    input() { return this; },
    query: async (sql) => {
      captured.push({ label, sql });
      // riskTableExists must see the table so the handler reaches the top-N queries.
      if (label === 'risk-table-check') return { recordset: [{ tbl: 'public.RiskScores' }] };
      return { recordset: [] };
    },
  }),
}));
vi.mock('../db/connection.js', () => ({ getPool: async () => ({}), query: async () => ({ rows: [] }), queryOne: async () => null }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, n) => n() }));
vi.mock('../db/queryHelpers.js', () => ({ queryRiskScoresPage: async () => ({ data: [], total: 0 }) }));

const { default: riskScoresRouter } = await import('./riskScores.js');
const app = express().use(express.json()).use(riskScoresRouter);

const sqlFor = (label) => captured.find(c => c.label === label)?.sql || '';

describe('GET /risk-scores summary — top-N queries are bounded', () => {
  it('caps top users/resources at LIMIT 10 and scored-at at LIMIT 1', async () => {
    const res = await request(app).get('/risk-scores');
    expect(res.status).toBe(200);
    expect(sqlFor('risk-top-users')).toMatch(/LIMIT\s+10/);
    expect(sqlFor('risk-top-resources')).toMatch(/LIMIT\s+10/);
    expect(sqlFor('risk-scored-at')).toMatch(/LIMIT\s+1\b/);
  });
});
