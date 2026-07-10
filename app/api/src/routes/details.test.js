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

// timedRequest(...).input(...).query(sql) → { recordset }. Route it through a
// controllable mock so each test can stage the rows the handler sees.
const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: () => ({ input() { return this; }, query: (sql) => timedQuery(sql) }),
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
  timedQuery.mockReset();
  dbQuery.mockReset();
});

describe('details — id validation (400 before any query)', () => {
  for (const path of ['/api/user/not-a-uuid', '/api/group/xyz', '/api/access-package/short']) {
    it(`rejects ${path}`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(timedQuery).not.toHaveBeenCalled();
      expect(dbQuery).not.toHaveBeenCalled();
    });
  }
});

describe('GET /user/:id — branching', () => {
  it('404 when the principal does not exist', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [] }); // user-attributes query → no row
    const res = await request(app).get(`/api/user/${VALID_ID}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /group/:id — branching', () => {
  it('404 when the group does not exist', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [] }); // group-attributes query → no row
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
    timedQuery.mockResolvedValue({ recordset: [GENERIC] });
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
