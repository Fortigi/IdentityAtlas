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

// Soft delete: relationship lists keep history but flag it (deleted + deletedAt,
// current first); the counts behind the detail bubbles include live rows only.
// SQL-blind mock — this pins the shape; resourceAndRoleDetailHistory.contract.test.js
// proves the behaviour against the real schema.
describe('details — soft-deleted rows are flagged in lists and left out of counts', () => {
  beforeEach(() => {
    stageQuery.mockResolvedValue({ recordset: [GENERIC] });
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });
  const sqlFor = (label) => stageQuery.mock.calls.find((c) => c[1] === label)?.[3];

  it.each([
    ['/api/access-package/ID/assignments', 'ap-assignments', 'LEAST(a."deletedAt", u."deletedAt") AS "deletedAt"'],
    ['/api/access-package/ID/resource-roles', 'ap-resource-roles', 'r."deletedAt" AS "deletedAt"'],
    ['/api/group/ID/access-packages', 'group-access-packages', 'ap."deletedAt" AS "deletedAt"'],
  ])('%s flags history', async (path, label, deletedAtExpr) => {
    await request(app).get(path.replace('ID', VALID_ID));
    const sql = sqlFor(label);
    expect(sql).toContain('AS "deleted"');
    expect(sql).toContain(deletedAtExpr);
    expect(sql).toMatch(/ORDER BY "deleted",/);
  });

  it('access-package counts exclude deleted assignments, principals and contained resources', async () => {
    await request(app).get(`/api/access-package/${VALID_ID}`);
    const assignments = sqlFor('ap-assignment-count');
    expect(assignments).toContain('a."deletedAt" IS NULL');
    expect(assignments).toContain('p."deletedAt" IS NOT NULL');
    expect(sqlFor('ap-group-count')).toContain('r."deletedAt" IS NOT NULL');
  });

  it('group business-role count excludes deleted roles', async () => {
    await request(app).get(`/api/group/${VALID_ID}`);
    expect(sqlFor('group-ap-count')).toContain('ap."deletedAt" IS NOT NULL');
  });
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

// Soft delete on the user side (migration 040). SQL-blind mock — this pins the SQL
// the user endpoints SEND: counts are of live counterparties / current grants,
// the relationship list keeps history but flags it. The rows themselves are
// checked by contract-tests/identityAndPeopleHistory.contract.test.js.
describe('user endpoints — soft-deleted counterparties, reports and grants', () => {
  const userSqlFor = (label) => stageQuery.mock.calls.find((c) => c[1] === label)?.[3];

  beforeEach(() => {
    stageQuery.mockResolvedValue({ recordset: [GENERIC] });
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('GET /user/:id counts only live counterparties, reports, grants and linked apps', async () => {
    await request(app).get(`/api/user/${VALID_ID}`);
    // The counterparty is the OTHER end of the link, and it must be live.
    expect(userSqlFor('user-principal-relationships')).toMatch(
      /JOIN "Principals" cp\s+ON cp\.id = CASE WHEN pr\."principalId"::text = \$1 THEN pr\."relatedPrincipalId" ELSE pr\."principalId" END\s+AND cp\."deletedAt" IS NULL/);
    expect(userSqlFor('user-reports-count')).toContain('"managerId" = $1 AND "deletedAt" IS NULL');
    const grants = userSqlFor('user-oauth2-grant-count');
    expect(grants).toContain('a."deletedAt" IS NULL');
    expect(grants).toContain('scope_res."deletedAt" IS NULL');
    expect(userSqlFor('user-linked-resource')).toContain(`"resourceType" = 'Application' AND "deletedAt" IS NULL`);
  });

  it('GET /user/:id/principal-relationships flags a deleted counterparty and lists current ones first', async () => {
    stageQuery.mockResolvedValueOnce({ rows: [{ principalId: 'b', deleted: false }, { principalId: 'a', deleted: true }] });
    const res = await request(app).get(`/api/user/${VALID_ID}/principal-relationships?type=Owner`);
    expect(res.body.map((r) => r.deleted)).toEqual([false, true]);
    const sql = userSqlFor('user-principal-relationships-list');
    expect(sql).toContain('(p."deletedAt" IS NOT NULL) AS "deleted", p."deletedAt"');
    expect(sql).toContain('ORDER BY "deleted", p."displayName"');
  });

  it('GET /user/:id/oauth2-grants leaves out deleted grants and scopes', async () => {
    await request(app).get(`/api/user/${VALID_ID}/oauth2-grants`);
    const sql = userSqlFor('user-oauth2-grants');
    expect(sql).toContain('a."deletedAt" IS NULL');
    expect(sql).toContain('scope_res."deletedAt" IS NULL');
  });
});

describe('GET /user/:id/activity', () => {
  const route = `/api/user/${VALID_ID}/activity`;

  it('rejects a malformed id before querying', async () => {
    const res = await request(app).get('/api/user/nope/activity');
    expect(res.status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('returns the aggregate and per-app lists', async () => {
    dbQuery.mockImplementation((sql) => Promise.resolve({
      rows: /LEFT JOIN "Principals" sp/.test(sql)
        ? [{ resourceId: VALID_ID, appDisplayName: 'App', measuredAt: '2026-09-16' }]
        : [{ activityType: 'SignIn', extendedAttributes: null, measuredAt: '2026-09-16' }],
    }));
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.body.aggregates).toEqual([{ activityType: 'SignIn', extendedAttributes: null, measuredAt: '2026-09-16' }]);
    expect(res.body.perApp).toEqual([{ resourceId: VALID_ID, appDisplayName: 'App', measuredAt: '2026-09-16' }]);
  });

  it('reads a database without the activity table as "no activity", not an error', async () => {
    dbQuery.mockRejectedValue(SCHEMA_ERR);
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ aggregates: [], perApp: [] });
  });

  it('surfaces a real failure as a 500 without leaking the message', async () => {
    dbQuery.mockRejectedValue(REAL_ERR);
    const res = await request(app).get(route);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch user activity' });
  });
});
