// Unit tests for POST /api/matrix/hierarchy-paths on routes/matrix.js.
//
// This endpoint backs sorting the matrix by a Manager-Hierarchy context tree.
// It 500'd on every call in the v5/Postgres default (`useSql` true): the handler
// guards its input with `isUuid(rootContextId)`, but matrix.js never imported
// `isUuid` — only the unrelated `UUID_RE`. ESM module scope has no global
// fallback, so the guard itself threw a ReferenceError before it could reject
// anything, and it threw *ahead of* the try/catch, so the request died uncaught.
//
// The guard is load-bearing twice over: it is also the only thing standing in
// front of the `'${rootContextId}'::uuid` string interpolation a few lines down.
// There was no injection only because the crash pre-empted it. So these tests
// pin the validation itself, not merely the absence of a 500 — a "fix" that
// dropped the guard to stop the crash would pass a status check and fail here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');
const { query } = await import('../db/connection.js');

const { default: router } = await import('./matrix.js');
const app = mountRouter(router);

const ROOT = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

const post = (body) => request(app).post('/api/matrix/hierarchy-paths').send(body);

describe('POST /matrix/hierarchy-paths', () => {
  it('returns each subject path and the max depth for a valid root', async () => {
    query.mockResolvedValue({
      rows: [
        { subjectId: 'p1', path: ['Fortigi', 'Engineering'] },
        { subjectId: 'p2', path: ['Fortigi'] },
      ],
    });
    const res = await post({ rootContextId: ROOT });
    expect(res.status).toBe(200);
    expect(res.body.paths).toEqual({ p1: ['Fortigi', 'Engineering'], p2: ['Fortigi'] });
    // depth is the LONGEST path, not the row count or the last row's length.
    expect(res.body.depth).toBe(2);
  });

  it('400s on an invalid rootContextId instead of crashing', async () => {
    const res = await post({ rootContextId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rootContextId/);
    // Rejected BEFORE the database was touched — the guard is the gate, not a
    // label on a query that ran anyway.
    expect(query).not.toHaveBeenCalled();
  });

  it('400s when rootContextId is missing entirely', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('400s on a non-string rootContextId rather than coercing it', async () => {
    // `UUID_RE.test(value)` would stringify its argument; isUuid type-checks
    // first. Objects and arrays must not reach the SQL interpolation.
    for (const bad of [42, true, { id: ROOT }, [ROOT], null]) {
      query.mockClear();
      const res = await post({ rootContextId: bad });
      expect(res.status, `accepted ${JSON.stringify(bad)}`).toBe(400);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('rejects a SQL-injection payload before it reaches the interpolated query', async () => {
    // rootContextId is interpolated into the CTE as '${id}'::uuid, so the UUID
    // guard IS the injection defence. This is the assertion that must never be
    // deleted to make a crash go away.
    const res = await post({ rootContextId: `' OR '1'='1` });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('scopes the walk to the requested root', async () => {
    await post({ rootContextId: ROOT });
    expect(query).toHaveBeenCalled();
    const sql = query.mock.calls[0][0];
    expect(sql).toContain(`'${ROOT}'::uuid`);
    // The recursive walk must keep its cycle guard: a corrupt parent chain in
    // Contexts would otherwise recurse forever.
    expect(sql).toMatch(/CYCLE id SET "isCycle"/);
  });

  it('joins through IdentityMembers when rowType is identity', async () => {
    await post({ rootContextId: ROOT, rowType: 'identity' });
    expect(query.mock.calls[0][0]).toContain('"IdentityMembers"');
  });

  it('defaults to principal rows for any other rowType', async () => {
    await post({ rootContextId: ROOT, rowType: 'bogus' });
    expect(query.mock.calls[0][0]).not.toContain('"IdentityMembers"');
  });

  it('500s with a generic message when the query itself fails', async () => {
    query.mockRejectedValue(new Error('relation "Contexts" does not exist'));
    const res = await post({ rootContextId: ROOT });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to load hierarchy paths');
  });
});
