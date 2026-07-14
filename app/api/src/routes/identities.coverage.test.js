/**
 * Coverage unit tests for routes/identities.js — DB mocked.
 *
 * Exercises the list / detail / by-user / contexts / assignments / columns
 * handlers and their error paths. Override + account-matrix + enrichMembers
 * are covered by identities.override.test.js / identities.enrich.test.js, so
 * we don't repeat those here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const VALID_ID  = '11111111-1111-1111-1111-111111111111';
const VALID_ID2 = '22222222-2222-2222-2222-222222222222';

// Hoisted so the mocks are in place before the router module initialises.
const { mockReq } = vi.hoisted(() => {
  process.env.USE_SQL = 'true';
  const mockReq = {
    input: vi.fn().mockReturnThis(),
    query: vi.fn().mockResolvedValue({ recordset: [] }),
  };
  return { mockReq };
});

// getPool() returns a pool whose .request() yields the chainable mockReq, and
// whose .request().query() is the same mock — identities.js calls both
// timedRequest(p,...).query() and p.request().query() directly.
vi.mock('../db/connection.js', () => ({
  getPool: vi.fn().mockResolvedValue({ request: () => mockReq }),
  queryOne: vi.fn().mockResolvedValue({ t: 'Identities' }),
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

// timedQuery (native #663 path, used by detail.js) routes to the same mockReq
// staging, normalising so a handler reading .rows gets the staged array whether
// the test staged .recordset (shim) or .rows.
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: (_pool, _label, _res) => mockReq,
  timedQuery: async (_pool, _label, _res, text, params) => {
    const r = await mockReq.query(text, params);
    if (r == null) return r;
    const arr = r.rows ?? r.recordset ?? [];
    return { ...r, rows: arr, recordset: arr };
  },
  getQueryTimings: () => [],
}));

// Permission middleware is a no-op so the write routes are reachable without auth.
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const { default: router } = await import('./identities.js');
const connection = await import('../db/connection.js');
const app = express().use(express.json()).use(router);

beforeEach(() => {
  vi.clearAllMocks();
  mockReq.input.mockReturnThis();
  mockReq.query.mockResolvedValue({ recordset: [] });
  connection.queryOne.mockResolvedValue({ t: 'Identities' });
});

// ── GET /identities (list + summary) ─────────────────────────────────────────

describe('GET /identities', () => {
  it('returns available:false when the Identities table is missing', async () => {
    connection.queryOne.mockResolvedValueOnce({ t: null });
    const res = await request(app).get('/identities');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it('returns a summary + paginated data on the happy path', async () => {
    // Sequence: colCheck (information_schema) → summary → typeDist → count → data
    mockReq.query
      .mockResolvedValueOnce({ recordset: [{ COLUMN_NAME: 'isHrAnchored' }, { COLUMN_NAME: 'orphanStatus' }] }) // colCheck (hasHrCols)
      .mockResolvedValueOnce({ recordset: [{ totalIdentities: 3, multiAccountIdentities: 1 }] })                // summary
      .mockResolvedValueOnce({ recordset: [{ accountType: 'admin', cnt: 2 }] })                                 // typeDist
      .mockResolvedValueOnce({ recordset: [{ total: 1 }] })                                                      // count
      .mockResolvedValueOnce({ recordset: [{ id: VALID_ID, displayName: 'Alice', tagString: '5:VIP:#fff' }] });  // data

    const res = await request(app).get('/identities?search=ali&minAccounts=2&confidence=50&sort=accountCount');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].displayName).toBe('Alice');
    expect(res.body.data[0].tags).toEqual([{ id: 5, name: 'VIP', color: '#fff' }]);
    expect(res.body.hasHrColumns).toBe(true);
  });

  it('applies hr/orphan/tag/attribute filters without error', async () => {
    mockReq.query
      .mockResolvedValueOnce({ recordset: [{ COLUMN_NAME: 'isHrAnchored' }, { COLUMN_NAME: 'orphanStatus' }] })
      .mockResolvedValueOnce({ recordset: [{ totalIdentities: 0 }] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [{ total: 0 }] })
      .mockResolvedValueOnce({ recordset: [] });

    const filters = JSON.stringify({ __identityTag: 'VIP', department: 'IT', bogusCol: 'x' });
    const res = await request(app).get(
      `/identities?hrAnchored=true&orphanStatus=any&filters=${encodeURIComponent(filters)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('returns 500 when a query rejects', async () => {
    mockReq.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/identities');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch identities/i);
  });
});

// ── GET /identities/:id (detail) ─────────────────────────────────────────────

describe('GET /identities/:id', () => {
  it('returns 400 for a malformed id', async () => {
    const res = await request(app).get('/identities/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns 404 when the identity row does not exist', async () => {
    mockReq.query.mockResolvedValueOnce({ recordset: [] }); // identity lookup empty
    const res = await request(app).get(`/identities/${VALID_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns identity + members + aggregate + contextCount', async () => {
    mockReq.query
      .mockResolvedValueOnce({ recordset: [{ id: VALID_ID, displayName: 'Bob' }] })          // identity
      .mockResolvedValueOnce({ recordset: [{ principalId: VALID_ID2, displayName: 'acc' }] }) // members
      .mockResolvedValueOnce({ recordset: [{ principalId: VALID_ID2, riskScore: 10, riskTier: 'Low' }] }) // risks
      .mockResolvedValueOnce({ recordset: [{ principalId: VALID_ID2, groupCount: 4 }] })      // group counts
      .mockResolvedValueOnce({ recordset: [{ assignmentType: 'Direct', cnt: 4 }] })           // aggregate
      .mockResolvedValueOnce({ recordset: [{ cnt: 2 }] });                                    // context count

    const res = await request(app).get(`/identities/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.identity.displayName).toBe('Bob');
    expect(res.body.members[0].groupCount).toBe(4);
    expect(res.body.members[0].riskScore).toBe(10);
    expect(res.body.aggregateAssignments.Direct).toBe(4);
    expect(res.body.contextCount).toBe(2);
  });

  it('returns 500 when the detail query rejects', async () => {
    mockReq.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/identities/${VALID_ID}`);
    expect(res.status).toBe(500);
  });
});

// ── GET /identities/:id/contexts ─────────────────────────────────────────────

describe('GET /identities/:id/contexts', () => {
  it('returns the context rows', async () => {
    mockReq.query.mockResolvedValueOnce({ recordset: [{ id: 1, displayName: 'Dept' }] });
    const res = await request(app).get(`/identities/${VALID_ID}/contexts`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, displayName: 'Dept' }]);
  });

  it('returns 500 on query failure', async () => {
    mockReq.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/identities/${VALID_ID}/contexts`);
    expect(res.status).toBe(500);
  });
});

// ── GET /identities/:id/assignments ──────────────────────────────────────────

describe('GET /identities/:id/assignments', () => {
  it('returns 400 for a malformed id', async () => {
    const res = await request(app).get('/identities/bad/assignments?type=Direct');
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid assignment type', async () => {
    const res = await request(app).get(`/identities/${VALID_ID}/assignments?type=Nope`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid assignment type/i);
  });

  it('returns assignment rows for a valid type', async () => {
    mockReq.query.mockResolvedValueOnce({ recordset: [{ resourceId: VALID_ID2 }] });
    const res = await request(app).get(`/identities/${VALID_ID}/assignments?type=Direct`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('returns 500 when the query rejects', async () => {
    mockReq.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/identities/${VALID_ID}/assignments?type=Direct`);
    expect(res.status).toBe(500);
  });
});

// ── GET /identities/by-user/:userId ──────────────────────────────────────────

describe('GET /identities/by-user/:userId', () => {
  it('returns 400 for a malformed user id', async () => {
    const res = await request(app).get('/identities/by-user/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns nulls when the Identities table is missing', async () => {
    connection.queryOne.mockResolvedValueOnce({ t: null });
    const res = await request(app).get(`/identities/by-user/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ identity: null, memberInfo: null });
  });

  it('returns nulls when the user is not a member of any identity', async () => {
    mockReq.query.mockResolvedValueOnce({ recordset: [] }); // memberResult empty
    const res = await request(app).get(`/identities/by-user/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.identity).toBeNull();
  });

  it('returns identity + memberInfo + otherMembers', async () => {
    mockReq.query
      .mockResolvedValueOnce({ recordset: [{
        identityId: VALID_ID2, identityDisplayName: 'Carol', accountCount: 2,
        accountType: 'admin', isPrimary: true, analystOverride: null,
      }] }) // memberResult
      .mockResolvedValueOnce({ recordset: [{ userId: VALID_ID, displayName: 'other' }] }); // others

    const res = await request(app).get(`/identities/by-user/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.identity.displayName).toBe('Carol');
    expect(res.body.memberInfo.accountType).toBe('admin');
    expect(res.body.otherMembers).toHaveLength(1);
  });

  it('returns 500 when the query rejects', async () => {
    mockReq.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/identities/by-user/${VALID_ID}`);
    expect(res.status).toBe(500);
  });
});

// ── GET /identity-columns ────────────────────────────────────────────────────

describe('GET /identity-columns', () => {
  it('returns empty schema-only column list', async () => {
    mockReq.query.mockResolvedValue({ recordset: [] });
    const res = await request(app).get('/identity-columns?schema=true');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const cols = res.body.map(c => c.column);
    expect(cols).toContain('displayName');
  });

  it('returns distinct values per column on the full path', async () => {
    mockReq.query.mockResolvedValue({ recordset: [{ v: 'IT' }, { name: 'VIP' }] });
    const res = await request(app).get('/identity-columns');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns [] when the Identities table is missing', async () => {
    connection.queryOne.mockResolvedValueOnce({ t: null });
    const res = await request(app).get('/identity-columns');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
