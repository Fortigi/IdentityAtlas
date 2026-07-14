// Regression guard for the /groups-with-nested expand-affordance query.
//
// The query joins ResourceRelationships.parentResourceId (uuid) to Resources.targetNodeId
// (a text generated column). Without an explicit `::text` cast, `uuid = text` has no operator
// and the query errors on real Postgres — which the endpoint swallows into an empty result,
// silently removing the matrix `>` expand control. The DB-mocked tests can't execute the SQL,
// so this asserts the cast is present in the emitted query; the real type-check runs against
// PG16 in pr-integration.yml.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.USE_SQL = 'true';

const captured = [];

vi.mock('../perf/sqlTimer.js', () => ({
  timedQuery: async (_p, _l, _r, sql) => { captured.push(sql); return { rows: [] }; },
}));
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({ query: async (sql) => { captured.push(sql); return { rows: [] }; } }),
  query: async () => ({ rows: [] }),
  queryOne: async () => null,
}));

const { default: permissionsRouter } = await import('./permissions.js');
const app = express();
app.use('/api', permissionsRouter);

describe('/groups-with-nested — Postgres type safety', () => {
  it('casts parentResourceId to text when comparing to targetNodeId (uuid=text regression)', async () => {
    captured.length = 0;
    const res = await request(app).get('/api/groups-with-nested');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.groupIds)).toBe(true);
    const sql = captured.join('\n');
    // The capability-resource branch must compare a uuid to the text generated column safely.
    expect(sql).toMatch(/"parentResourceId"::text\s*=\s*r\."targetNodeId"/);
  });
});
