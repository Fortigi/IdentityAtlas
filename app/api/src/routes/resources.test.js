// Unit tests for routes/resources.js — list filter-building + detail branching,
// DB mocked. The real SQL is covered by resources.contract.test.js; here we pin
// the handler logic (response shape, the resourceType filter branch, 400/404).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

// db.query backs the list (data + count, native $N) and the optional-data reads
// in GET /resources/:id (RiskScores, history, context counts). db.queryOne backs
// the history/context counts. getPool() is only handed to mocked helpers.
const mockDb = { query: vi.fn(), queryOne: vi.fn() };
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({}),
  query: (...a) => mockDb.query(...a),
  queryOne: (...a) => mockDb.queryOne(...a),
}));

// timedQuery is used by GET /resources/:id; forward its (sql, values) to a spy.
const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedQuery: (_p, _l, _r, sql, values) => timedQuery(sql, values),
  getQueryTimings: () => [],
}));

vi.mock('../db/columnCache.js', () => ({
  getResourceColumns: async () => [{ name: 'displayName' }, { name: 'resourceType' }],
  getResourceColumnValues: vi.fn(),
}));
// parseTags is a pure helper re-exported from ./tags/shared.js — use the real
// one so the tag-parsing assertion reflects production behaviour.
vi.mock('./tags.js', async () => {
  const { parseTags } = await vi.importActual('./tags/shared.js');
  return {
    ensureTagTables: async () => {},
    buildFilterWhere: () => '',
    parseTags,
  };
});

const { default: router } = await import('./resources.js');
const app = mountRouter(router);

const VALID_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  timedQuery.mockReset();
  mockDb.query.mockReset();
  mockDb.query.mockResolvedValue({ rows: [] });
  mockDb.queryOne.mockReset();
});

describe('GET /resources — list', () => {
  // The list fires the data query then (page 1) the COUNT query, both via db.query.
  const stageList = (dataRows, total) => {
    mockDb.query.mockReset();
    mockDb.query
      .mockResolvedValueOnce({ rows: dataRows })
      .mockResolvedValueOnce({ rows: [{ total }] });
  };
  const listSql = () => mockDb.query.mock.calls[0][0];   // the data query text

  it('returns { data, total } with parsed tags and backward-compat aliases', async () => {
    stageList(
      [{ id: 'r1', displayName: 'Eng', description: 'd', resourceType: 'Group', extendedAttributes: null, tagString: null }],
      1,
    );
    const res = await request(app).get('/api/resources');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: 'r1', groupId: 'r1', groupTypeCalculated: 'Group', tags: [] });
  });

  it('filters by resourceType when supplied', async () => {
    await request(app).get('/api/resources?resourceType=Group');
    expect(listSql()).toContain('r."resourceType" =');
    // The value is bound positionally (not inlined) — it appears in the params.
    expect(mockDb.query.mock.calls[0][1]).toContain('Group');
  });

  it('excludes BusinessRole resources when no resourceType filter is given', async () => {
    await request(app).get('/api/resources');
    expect(listSql()).toContain(`r."resourceType" <> 'BusinessRole'`);
  });

  it('includes BusinessRole resources when ?includeBusinessRoles=true (governance export)', async () => {
    await request(app).get('/api/resources?includeBusinessRoles=true');
    expect(listSql()).not.toContain(`r."resourceType" <> 'BusinessRole'`);
  });

  it('selects the governanceResource flag so business roles are identifiable', async () => {
    await request(app).get('/api/resources?includeBusinessRoles=true');
    expect(listSql()).toContain('"governanceResource"');
  });
});

describe('GET /resources/:id — detail', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).get('/api/resources/not-a-uuid');
    expect(res.status).toBe(400);
    expect(timedQuery).not.toHaveBeenCalled();
  });

  it('404 when the resource does not exist', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [] });
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
  const okRow = { rows: [{ id: VALID_ID, displayName: 'Eng', cnt: 0, assignmentType: 'Direct' }] };
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

// The endpoint shares its SQL with the matrix Contexts-column batch via
// buildResourceContextsSql (issue #870) — pin that the single-resource filter
// and the shared join both reach the database.
describe('GET /resources/:id/contexts', () => {
  it('400 on a non-UUID id', async () => {
    const res = await request(app).get('/api/resources/not-a-uuid/contexts');
    expect(res.status).toBe(400);
  });

  it('runs the shared ContextMembers→Contexts join filtered to this resource', async () => {
    const rows = [
      { resourceId: VALID_ID, id: 'c1', displayName: 'Finance', contextType: 'Tag', targetType: 'Resource', variant: 'manual' },
    ];
    mockDb.query.mockResolvedValueOnce({ rows });
    const res = await request(app).get(`/api/resources/${VALID_ID}/contexts`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    const [sql, values] = mockDb.query.mock.calls[0];
    expect(sql).toContain('FROM "ContextMembers" cm');
    expect(sql).toContain(`cm."memberId"::text = $1`);
    expect(sql).toContain('ORDER BY cm."memberId", c."contextType", c."displayName"');
    expect(values).toEqual([VALID_ID]);
  });

  it('500s with a generic message when the query fails', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/api/resources/${VALID_ID}/contexts`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch resource contexts');
  });
});
