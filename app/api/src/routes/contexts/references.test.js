// Unit tests for routes/contexts/references.js — one member's references.
// DB mocked (the pool routes back through the query spy).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query } from '../../db/connection.js';
process.env.USE_SQL = 'true';

const { default: router } = await import('./references.js');
const app = mountRouter(router);

const CTX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const url = (ctx = CTX, member = MEMBER) => `/api/contexts/${ctx}/members/${member}/references`;

beforeEach(() => {
  query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /contexts/:id/members/:memberId/references', () => {
  it.each([
    [url('not-a-uuid'), 'a bad context id'],
    [url(CTX, 'nope'), 'a bad member id'],
  ])('answers 400 for %s (%s) without touching the database', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that is not a member of this context', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(url());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not a member of this context' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([CTX, MEMBER]);
  });

  it('answers the reference groups for a member', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ memberType: 'System' }] })
      .mockResolvedValueOnce({ rows: [{ displayName: 'Sales', contextType: 'Department', targetType: 'System', total: '3' }] });
    const res = await request(app).get(url());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      memberType: 'System',
      groups: [{ key: 'contexts', items: [{ displayName: 'Sales', contextType: 'Department', targetType: 'System' }], total: 3 }],
    });
  });

  it('answers a generic 500 when the read fails', async () => {
    query.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    const res = await request(app).get(url());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load member references' });
  });
});
