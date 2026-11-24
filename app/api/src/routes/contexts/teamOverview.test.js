// Route tests for GET /contexts/:id/team-overview. DB mocked; the SQL is checked
// against PostgreSQL in contract-tests/teamOverview.contract.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
vi.mock('../../contexts/teamOverview.js', () => ({ loadTeamOverview: vi.fn() }));
vi.mock('../../contexts/teamUngoverned.js', () => ({ loadUngoverned: vi.fn() }));
vi.mock('../../contexts/memberReferences.js', () => ({ findContextMember: vi.fn() }));
vi.mock('../../featureFlags.js', async (original) => ({ ...(await original()), orgKnowledgeEnabled: vi.fn() }));
import { queryOne } from '../../db/connection.js';
import { loadTeamOverview } from '../../contexts/teamOverview.js';
import { orgKnowledgeEnabled } from '../../featureFlags.js';
import { loadUngoverned } from '../../contexts/teamUngoverned.js';
import { findContextMember } from '../../contexts/memberReferences.js';
process.env.USE_SQL = 'true';

const { default: router, overviewDays } = await import('./teamOverview.js');
const app = mountRouter(router);
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const url = (q = '') => `/api/contexts/${ID}/team-overview${q}`;
const UNIT = { id: ID, targetType: 'Principal', contextCategory: 'OrganizationalUnit' };

beforeEach(() => {
  queryOne.mockReset();
  loadTeamOverview.mockReset();
  loadUngoverned.mockReset();
  findContextMember.mockReset();
  orgKnowledgeEnabled.mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('overviewDays', () => {
  it.each([[undefined, 30], ['abc', 30], ['0', 30], ['-4', 30], ['1', 1], ['365', 365], ['366', 365]])('%s → %i', (input, out) => {
    expect(overviewDays(input)).toBe(out);
  });
});

describe('GET /contexts/:id/team-overview/:memberId/ungoverned', () => {
  const MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const path = (ctx = ID, member = MEMBER) => `/api/contexts/${ctx}/team-overview/${member}/ungoverned`;

  it.each([[path('nope')], [path(ID, 'nope')]])('refuses the malformed %s', async (p) => {
    expect((await request(app).get(p)).status).toBe(400);
    expect(findContextMember).not.toHaveBeenCalled();
  });

  it('answers 404 for someone who is not a member, without reading their access', async () => {
    findContextMember.mockResolvedValueOnce(null);
    expect((await request(app).get(path())).status).toBe(404);
    expect(findContextMember.mock.calls[0].slice(1)).toEqual([ID, MEMBER]);
    expect(loadUngoverned).not.toHaveBeenCalled();
  });

  it('answers with the list of that member', async () => {
    findContextMember.mockResolvedValueOnce({ memberType: 'Principal' });
    loadUngoverned.mockResolvedValueOnce({ items: [{ id: 'r' }], truncated: false });
    const res = await request(app).get(path());
    expect(res.body).toEqual({ items: [{ id: 'r' }], truncated: false });
    expect(loadUngoverned.mock.calls[0][1]).toBe(MEMBER);
  });

  it('hides the reason of a failure', async () => {
    findContextMember.mockResolvedValueOnce({ memberType: 'Principal' });
    loadUngoverned.mockRejectedValueOnce(new Error('secret table detail'));
    const res = await request(app).get(path());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load the ungoverned permissions' });
  });
});

describe('GET /contexts/:id/team-overview', () => {
  it('refuses a malformed id without touching the database', async () => {
    const res = await request(app).get('/api/contexts/nope/team-overview');
    expect(res.status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown context', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await request(app).get(url())).status).toBe(404);
  });

  it.each([
    ['an application', { ...UNIT, contextCategory: 'LogicalApplication' }],
    ['a unit of resources', { ...UNIT, targetType: 'Resource' }],
  ])('refuses %s', async (_name, ctx) => {
    queryOne.mockResolvedValueOnce(ctx);
    expect((await request(app).get(url())).status).toBe(400);
    expect(loadTeamOverview).not.toHaveBeenCalled();
  });

  it.each([[true, false], [false, true]])('with organisation knowledge %s, includeOverridden is %s', async (knowledge, includeOverridden) => {
    queryOne.mockResolvedValueOnce(UNIT);
    orgKnowledgeEnabled.mockResolvedValue(knowledge);
    loadTeamOverview.mockResolvedValueOnce({ people: [] });
    const res = await request(app).get(url('?sinceDays=14'));
    expect(res.status).toBe(200);
    expect(loadTeamOverview.mock.calls[0][2]).toEqual({ sinceDays: 14, includeOverridden });
  });

  it('hides the reason of a failure', async () => {
    queryOne.mockResolvedValueOnce(UNIT);
    loadTeamOverview.mockRejectedValueOnce(new Error('secret table detail'));
    const res = await request(app).get(url());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load the team overview' });
  });
});
