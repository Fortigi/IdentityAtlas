// fetchPrincipalActivity — the query behind GET /api/user/:id/activity.
//
// The DB is mocked; contract tests own the real SQL. What is pinned here is
// what the route promises its page: aggregate and per-app rows are fetched
// separately and bound to the principal, a JSONB column that arrives as text
// becomes an object, and an app nobody crawled still lists — with a null name,
// never an empty string the page would render as a blank cell.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { fetchPrincipalActivity } from './userActivity.js';

const ID = '11111111-1111-1111-1111-111111111111';
const APP = '22222222-2222-2222-2222-222222222222';

// Route by SQL shape, not call order: the two queries run under Promise.all.
function stage({ aggregates = [], perApp = [] }) {
  query.mockImplementation((sql) =>
    Promise.resolve({ rows: /LEFT JOIN "Principals" sp/.test(sql) ? perApp : aggregates }));
}

beforeEach(() => { query.mockReset(); });

describe('fetchPrincipalActivity', () => {
  it('returns empty lists — not an error — for a principal with no activity', async () => {
    stage({});
    await expect(fetchPrincipalActivity(ID)).resolves.toEqual({ aggregates: [], perApp: [] });
  });

  it('binds the principal to both queries, and the per-app type to the per-app one', async () => {
    stage({});
    await fetchPrincipalActivity(ID);
    const calls = query.mock.calls;
    expect(calls).toHaveLength(2);
    const agg = calls.find(([sql]) => !/LEFT JOIN "Principals" sp/.test(sql));
    const app = calls.find(([sql]) => /LEFT JOIN "Principals" sp/.test(sql));
    expect(agg[1]).toEqual([ID]);
    expect(agg[0]).toContain("'00000000-0000-0000-0000-000000000000'::uuid");
    expect(app[1]).toEqual([ID, 'SignInPerApp']);
  });

  it('parses a text JSONB column and leaves an already-parsed one alone', async () => {
    stage({
      aggregates: [
        { activityType: 'ServicePrincipalSignIn', extendedAttributes: '{"lastDelegatedClientSignInDateTime":"2026-09-01T00:00:00Z"}', measuredAt: 'm1' },
        { activityType: 'SignIn', extendedAttributes: { already: 'object' }, measuredAt: 'm2' },
        { activityType: 'SignIn', extendedAttributes: null, measuredAt: 'm3' },
      ],
    });
    const { aggregates } = await fetchPrincipalActivity(ID);
    expect(aggregates.map(a => a.extendedAttributes)).toEqual([
      { lastDelegatedClientSignInDateTime: '2026-09-01T00:00:00Z' },
      { already: 'object' },
      null,
    ]);
    // every other column passes through untouched, including the measurement
    expect(aggregates.map(a => [a.activityType, a.measuredAt]))
      .toEqual([['ServicePrincipalSignIn', 'm1'], ['SignIn', 'm2'], ['SignIn', 'm3']]);
  });

  it('keeps an uncrawled app with a null name rather than dropping or blanking it', async () => {
    stage({
      perApp: [
        { resourceId: APP, appDisplayName: 'Ticketing', signInCount: 4 },
        { resourceId: ID, appDisplayName: '', signInCount: 1 },
        { resourceId: ID, appDisplayName: null, signInCount: 2 },
      ],
    });
    const { perApp } = await fetchPrincipalActivity(ID);
    expect(perApp.map(p => [p.appDisplayName, p.signInCount])).toEqual([['Ticketing', 4], [null, 1], [null, 2]]);
  });

  it('propagates a query failure so the route can decide what it means', async () => {
    query.mockRejectedValue(Object.assign(new Error('relation missing'), { code: '42P01' }));
    await expect(fetchPrincipalActivity(ID)).rejects.toMatchObject({ code: '42P01' });
  });
});
