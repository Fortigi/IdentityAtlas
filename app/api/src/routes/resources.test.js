// Unit tests for routes/resources.js — list filter-building + detail branching,
// DB mocked. The real SQL is covered by resources.contract.test.js; here we pin
// the handler logic (response shape, the resourceType filter branch, 400/404).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

// pool.request() recorder — captures the SQL + bound inputs of the list query
// and returns a controllable result.
let captured = { sql: '', inputs: {} };
let nextListResult = { recordsets: [[], [{ total: 0 }]] };
const mockPool = {
  request() {
    captured = { sql: '', inputs: {} };
    const r = {
      input(n, v) { captured.inputs[n] = v; return r; },
      query(sql) { captured.sql = sql; return Promise.resolve(nextListResult); },
    };
    return r;
  },
};

// db.query / db.queryOne back the optional-data reads in GET /resources/:id
// (RiskScores, history, context counts) — exposed so the de-masking tests below
// can make a single optional read fail on demand.
const mockDb = { query: vi.fn(), queryOne: vi.fn() };
vi.mock('../db/connection.js', () => ({
  getPool: async () => mockPool,
  query: (...a) => mockDb.query(...a),
  queryOne: (...a) => mockDb.queryOne(...a),
}));

// timedRequest is used only by GET /resources/:id.
const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: () => ({ input() { return this; }, query: (sql) => timedQuery(sql) }),
  getQueryTimings: () => [],
}));

vi.mock('../db/columnCache.js', () => ({
  getResourceColumns: async () => [{ name: 'displayName' }, { name: 'resourceType' }],
  getResourceColumnValues: vi.fn(),
}));
vi.mock('./tags.js', () => ({
  ensureTagTables: async () => {},
  buildFilterWhere: () => '',
}));

const { default: router } = await import('./resources.js');
const app = mountRouter(router);

const VALID_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  timedQuery.mockReset();
  nextListResult = { recordsets: [[], [{ total: 0 }]] };
});

describe('GET /resources — list', () => {
  it('returns { data, total } with parsed tags and backward-compat aliases', async () => {
    nextListResult = {
      recordsets: [
        [{ id: 'r1', displayName: 'Eng', description: 'd', resourceType: 'Group', extendedAttributes: null, tagString: null }],
        [{ total: 1 }],
      ],
    };
    const res = await request(app).get('/api/resources');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: 'r1', groupId: 'r1', groupTypeCalculated: 'Group', tags: [] });
  });

  it('filters by resourceType when supplied', async () => {
    await request(app).get('/api/resources?resourceType=Group');
    expect(captured.sql).toContain('r."resourceType" = @resourceType');
    expect(captured.inputs.resourceType).toBe('Group');
  });

  it('excludes BusinessRole resources when no resourceType filter is given', async () => {
    await request(app).get('/api/resources');
    expect(captured.sql).toContain(`r."resourceType" <> 'BusinessRole'`);
  });

  it('includes BusinessRole resources when ?includeBusinessRoles=true (governance export)', async () => {
    await request(app).get('/api/resources?includeBusinessRoles=true');
    expect(captured.sql).not.toContain(`r."resourceType" <> 'BusinessRole'`);
  });

  it('selects the governanceResource flag so business roles are identifiable', async () => {
    await request(app).get('/api/resources?includeBusinessRoles=true');
    expect(captured.sql).toContain('"governanceResource"');
  });
});

describe('GET /resources/:id — detail', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).get('/api/resources/not-a-uuid');
    expect(res.status).toBe(400);
    expect(timedQuery).not.toHaveBeenCalled();
  });

  it('404 when the resource does not exist', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [] });
    const res = await request(app).get(`/api/resources/${VALID_ID}`);
    expect(res.status).toBe(404);
  });
});

// Audit finding Q2: optional-data reads (RiskScores, tags, counts, history) are
// each wrapped in try/catch. They must swallow ONLY a missing table/column/view
// and let every other error surface — otherwise a real failure silently returns
// a 200 with empty/zero data, masking the outage.
describe('GET /resources/:id — optional-data error handling (Q2 de-masking)', () => {
  // A resource row (passes the 404 gate) + cnt:0 for every count query.
  const okRow = { recordset: [{ id: VALID_ID, displayName: 'Eng', cnt: 0, assignmentType: 'Direct' }] };
  beforeEach(() => {
    timedQuery.mockReset();
    timedQuery.mockResolvedValue(okRow);
    mockDb.query.mockReset();
    mockDb.query.mockResolvedValue({ rows: [] });   // RiskScores
    mockDb.queryOne.mockReset();
    mockDb.queryOne.mockResolvedValue({ cnt: 0 });   // history + context counts
  });

  it('degrades to 200 when an optional table/view is absent (missing-schema code)', async () => {
    mockDb.query.mockRejectedValueOnce({ code: '42P01' }); // RiskScores table missing
    const res = await request(app).get(`/api/resources/${VALID_ID}`);
    expect(res.status).toBe(200);
  });

  it('surfaces a 500 when an optional read fails for a non-schema reason', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('connection reset')); // real failure
    const res = await request(app).get(`/api/resources/${VALID_ID}`);
    expect(res.status).toBe(500);
  });
});
