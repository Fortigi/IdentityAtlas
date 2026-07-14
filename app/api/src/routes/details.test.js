// Unit tests for routes/details.js — input validation + branching, DB mocked.
//
// details.js has the lowest route coverage in the API. These pin the cheap,
// high-value contracts: malformed ids are rejected before any query, and the
// entity-detail handlers 404 when the row is absent. The DB layer is mocked so
// no container is needed (contract tests cover the real SQL).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

// useSql is captured at module load — enable it before importing the router.
process.env.USE_SQL = 'true';

// One staging mock for the native timedQuery(...) — these routes are all pg-native (#663).
// Normalise the result so a handler reading .rows (native) OR .recordset (shim)
// gets the staged array either way, so a route can migrate without its tests
// changing what they stage.
const stageQuery = vi.fn();
const runQuery = async (...args) => {
  const r = await stageQuery(...args);
  if (r == null) return r;
  const arr = r.rows ?? r.recordset ?? [];
  return { ...r, rows: arr, recordset: arr };
};
vi.mock('../perf/sqlTimer.js', () => ({
  timedQuery: (...a) => runQuery(...a),
  getQueryTimings: () => [],
}));

const dbQuery = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({}),
  query: (...a) => dbQuery(...a),
  queryOne: vi.fn(),
}));

const { default: router } = await import('./details.js');
const app = mountRouter(router);

const VALID_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  stageQuery.mockReset();
  dbQuery.mockReset();
});

describe('details — id validation (400 before any query)', () => {
  for (const path of ['/api/user/not-a-uuid', '/api/group/xyz', '/api/access-package/short']) {
    it(`rejects ${path}`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(stageQuery).not.toHaveBeenCalled();
      expect(dbQuery).not.toHaveBeenCalled();
    });
  }
});

describe('GET /user/:id — branching', () => {
  it('404 when the principal does not exist', async () => {
    stageQuery.mockResolvedValueOnce({ recordset: [] }); // user-attributes query → no row
    const res = await request(app).get(`/api/user/${VALID_ID}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /group/:id — branching', () => {
  it('404 when the group does not exist', async () => {
    stageQuery.mockResolvedValueOnce({ recordset: [] }); // group-attributes query → no row
    const res = await request(app).get(`/api/group/${VALID_ID}`);
    expect(res.status).toBe(404);
  });
});

// Happy-path coverage: a generic non-empty row for every timed query drives the
// detail + list handlers through their success branches (200). db.query returns
// empty (risk/history absent — both guarded). We assert status + the top-level
// response keys, not full bodies; the real SQL/shape is covered by contract tests.
const GENERIC = { id: 'x', displayName: 'X', name: 'X', cnt: 0, total: 0, autoAdd: 0, autoRemoveOnly: 0 };

describe('details — happy paths (200)', () => {
  beforeEach(() => {
    stageQuery.mockResolvedValue({ recordset: [GENERIC] });
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('GET /user/:id returns the detail payload', async () => {
    const res = await request(app).get(`/api/user/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('attributes');
    expect(res.body).toHaveProperty('membershipCount');
    // Principal→principal relationship counts + linked resource (migration 057).
    expect(res.body).toHaveProperty('ownerCount');
    expect(res.body).toHaveProperty('sponsorCount');
    expect(res.body).toHaveProperty('ownedAgentCount');
    expect(res.body).toHaveProperty('sponsoredGuestCount');
    expect(res.body).toHaveProperty('linkedResource');
  });

  it.each([
    ['?type=Owner', 'Owner-subject'],
    ['?type=Sponsor&reverse=true', 'Sponsor-reverse'],
    ['', 'default'],
  ])('GET /user/:id/principal-relationships %s returns 200', async (qs) => {
    const res = await request(app).get(`/api/user/${VALID_ID}/principal-relationships${qs}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /user/:id/principal-relationships → 500 when the query fails', async () => {
    stageQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/api/user/${VALID_ID}/principal-relationships`);
    expect(res.status).toBe(500);
  });

  it('GET /group/:id returns the detail payload', async () => {
    const res = await request(app).get(`/api/group/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('attributes');
    expect(res.body).toHaveProperty('memberCount');
  });

  it('GET /access-package/:id returns the detail payload', async () => {
    const res = await request(app).get(`/api/access-package/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('attributes');
    expect(res.body).toHaveProperty('assignmentCount');
  });

  for (const sub of ['/contexts', '/memberships', '/access-packages', '/oauth2-grants', '/history']) {
    it(`GET /user/:id${sub} returns 200`, async () => {
      expect((await request(app).get(`/api/user/${VALID_ID}${sub}`)).status).toBe(200);
    });
  }

  for (const sub of ['/members', '/access-packages', '/history']) {
    it(`GET /group/:id${sub} returns 200`, async () => {
      expect((await request(app).get(`/api/group/${VALID_ID}${sub}`)).status).toBe(200);
    });
  }

  for (const sub of ['/assignments', '/resource-roles', '/reviews', '/requests', '/history', '/policies']) {
    it(`GET /access-package/:id${sub} returns 200`, async () => {
      expect((await request(app).get(`/api/access-package/${VALID_ID}${sub}`)).status).toBe(200);
    });
  }
});

// Error-handling branches of the split modules. A real (non-schema) error on the
// PRIMARY query of each handler must surface as the handler's failure response —
// a 500 for the detail/list endpoints, a graceful empty body for the lazy
// history/AP sub-resources that deliberately degrade to []. This pins every
// outer catch (and the group/AP "try new model, fall back to legacy" pairs,
// where both legs failing propagates to the outer catch).
const REAL_ERR = new Error('boom');          // no .code -> isMissingSchema=false -> surfaces
const SCHEMA_ERR = { code: '42P01' };        // undefined_table -> isMissingSchema=true -> swallowed

describe('details — primary-query failure surfaces as the handler error response', () => {
  beforeEach(() => {
    stageQuery.mockRejectedValue(REAL_ERR);
    dbQuery.mockRejectedValue(REAL_ERR);
  });

  const cases = [
    ['/api/user/ID', 500],
    ['/api/user/ID/contexts', 500],
    ['/api/user/ID/memberships', 500],
    ['/api/user/ID/access-packages', 500],
    ['/api/user/ID/oauth2-grants', 500],
    ['/api/user/ID/history', 200],            // degrades to []
    ['/api/group/ID', 500],                   // new + legacy attribute queries both fail
    ['/api/group/ID/members', 500],
    ['/api/group/ID/access-packages', 500],
    ['/api/group/ID/history', 200],
    ['/api/access-package/ID', 500],          // new + legacy attribute queries both fail
    ['/api/access-package/ID/assignments', 200],
    ['/api/access-package/ID/resource-roles', 200],
    ['/api/access-package/ID/reviews', 200],
    ['/api/access-package/ID/requests', 200], // new + legacy requestor queries both fail
    ['/api/access-package/ID/history', 200],
    ['/api/access-package/ID/policies', 200],
  ];
  for (const [path, status] of cases) {
    it(`${path} -> ${status}`, async () => {
      const res = await request(app).get(path.replace('ID', VALID_ID));
      expect(res.status).toBe(status);
    });
  }
});

describe('details — optional-schema sub-queries are swallowed and the detail still renders', () => {
  // The lightweight detail handlers wrap each optional side-query (tags, counts,
  // history, category, …) so a missing table/column (42P01) degrades to a
  // zero/empty field instead of failing the whole page. Stage the primary
  // attributes query as present, then make every follow-up query report a
  // missing relation — the handler must still 200.
  it('GET /user/:id swallows missing optional tables', async () => {
    stageQuery.mockResolvedValueOnce({ recordset: [GENERIC] }).mockRejectedValue(SCHEMA_ERR);
    dbQuery.mockRejectedValue(SCHEMA_ERR);
    expect((await request(app).get(`/api/user/${VALID_ID}`)).status).toBe(200);
  });

  it('GET /group/:id swallows missing tables, guards bad extendedAttributes, and falls back on member-count', async () => {
    stageQuery
      .mockResolvedValueOnce({ recordset: [{ ...GENERIC, extendedAttributes: 'not-json' }] })
      .mockRejectedValue(SCHEMA_ERR);
    dbQuery.mockRejectedValue(SCHEMA_ERR);
    expect((await request(app).get(`/api/group/${VALID_ID}`)).status).toBe(200);
  });

  it('GET /access-package/:id swallows missing tables (counts, policies, category, history)', async () => {
    stageQuery.mockResolvedValueOnce({ recordset: [GENERIC] }).mockRejectedValue(SCHEMA_ERR);
    dbQuery.mockRejectedValue(SCHEMA_ERR);
    expect((await request(app).get(`/api/access-package/${VALID_ID}`)).status).toBe(200);
  });
});

describe('access-package detail — compliance status of the latest review instance', () => {
  // The compliance CTE (db.query) drives a small state machine; the _history
  // count query (also db.query) must not be mistaken for it, so route by SQL.
  const withCompliance = (row) => {
    stageQuery.mockResolvedValue({ recordset: [GENERIC] });
    dbQuery.mockImplementation((sql) =>
      /reviewInstanceId/.test(sql)
        ? Promise.resolve({ rows: [row] })
        : Promise.resolve({ rows: [], rowCount: 0 }));
  };
  const PAST = '2020-01-01T00:00:00Z';
  const FUTURE = '2999-01-01T00:00:00Z';

  const scenarios = [
    ['Compliant', { deadline: PAST, notReviewed: 0, late: 0 }],
    ['In Progress', { deadline: FUTURE, notReviewed: 2, late: 0 }],
    ['Missed', { deadline: PAST, notReviewed: 2, late: 0 }],
    ['Reviewed Late', { deadline: PAST, notReviewed: 0, late: 1 }],
  ];
  for (const [expected, row] of scenarios) {
    it(`reports "${expected}"`, async () => {
      withCompliance(row);
      const res = await request(app).get(`/api/access-package/${VALID_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.complianceStatus).toBe(expected);
    });
  }
});
