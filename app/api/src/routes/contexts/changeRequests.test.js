// Route tests for the change-request list: filters → the module, bad filters → 400,
// failures → 500, no SQL backend → 503. The list itself is contexts/changeRequests.test.js's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
vi.mock('../../contexts/changeRequests.js', async (orig) => ({ ...(await orig()), listChangeRequests: vi.fn() }));
process.env.USE_SQL = 'true';
process.env.FEATURE_ORG_KNOWLEDGE = 'true'; // change requests are organisation knowledge

const { default: router } = await import('./changeRequests.js');
const { listChangeRequests } = await import('../../contexts/changeRequests.js');
const db = await import('../../db/connection.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const reader = { email: 'reader@example.test', permissions: ['data.read'] };
const app = mountRouterAs(router, () => reader);

beforeEach(() => vi.mocked(listChangeRequests).mockReset());

describe('GET /change-requests', () => {
  it('answers 404 and never reads while organisation knowledge is off', async () => {
    process.env.FEATURE_ORG_KNOWLEDGE = 'false';
    try {
      const res = await request(app).get('/api/change-requests');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'This feature is not enabled' });
      expect(listChangeRequests).not.toHaveBeenCalled();
    } finally {
      process.env.FEATURE_ORG_KNOWLEDGE = 'true';
    }
  });

  it('serves a reader the list, with the filters parsed', async () => {
    const body = { items: [{ id: 'r1', summary: 'Remove Led from Klanten' }], counts: { open: 1, resolved: 0, withdrawn: 0 } };
    vi.mocked(listChangeRequests).mockResolvedValue(body);
    const res = await request(app).get(`/api/change-requests?status=open&systemId=7&contextId=${CTX}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(listChangeRequests).toHaveBeenCalledWith(db, { status: 'open', systemId: 7, contextId: CTX });
  });

  it('answers a bad filter with 400 and never reads', async () => {
    const res = await request(app).get('/api/change-requests?status=sent');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status must be one of/);
    expect(listChangeRequests).not.toHaveBeenCalled();
  });

  it('answers a failure with 500 and a generic message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(listChangeRequests).mockRejectedValueOnce(new Error('connection reset'));
    const res = await request(app).get('/api/change-requests');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Listing change requests failed' });
  });
});

describe('without the SQL backend', () => {
  it('answers 503', async () => {
    vi.resetModules();
    process.env.USE_SQL = 'false';
    const { default: noSql } = await import('./changeRequests.js');
    process.env.USE_SQL = 'true';
process.env.FEATURE_ORG_KNOWLEDGE = 'true'; // change requests are organisation knowledge
    const res = await request(mountRouterAs(noSql, () => reader)).get('/api/change-requests');
    expect(res.status).toBe(503);
  });
});
