// GET /api/contexts/:id/people — the route around loadPeople (whose rules are
// contexts/interviews/people*.test.js): its guards, the reader narrowing, and the
// dependencies it hands over (the members endpoint's own read and the roles read).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';
vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
let authOn = true;
vi.mock('../../config/authConfig.js', () => ({ isAuthEnabled: () => authOn }));
vi.mock('../../contexts/interviews/peopleLoad.js', () => ({ loadPeople: vi.fn(), loadListedPeople: vi.fn() }));
// Organisation knowledge on unless a test switches it off; read from a variable so it
// never takes one of the staged queryOne answers.
let orgKnowledge = true;
vi.mock('../../featureFlags.js', async (orig) => ({ ...(await orig()), orgKnowledgeEnabled: async () => orgKnowledge }));
const { loadPeople, loadListedPeople } = await import('../../contexts/interviews/peopleLoad.js');
const { default: router, PEOPLE_DEPS, LISTED_PEOPLE_DEPS, loadMembers } = await import('./read.js');
const { loadContextRoles } = await import('./roles.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const analyst = { email: 'analyst@example.test', permissions: ['data.read', 'data.write.contexts'] };
const owner = { email: 'owner@example.test', contextOwner: { contextIds: new Set([CTX]) }, permissions: [] };
let caller = analyst;
const app = mountRouterAs(router, () => caller);
const unit = { id: CTX, targetType: 'Principal', contextCategory: 'OrganizationalUnit' };

beforeEach(() => {
  orgKnowledge = true;
  vi.mocked(loadListedPeople).mockReset();
  caller = analyst;
  authOn = true;
  queryOne.mockReset();
  vi.mocked(loadPeople).mockReset();
});

describe('GET /contexts/:id/people', () => {
  it('hands the context, the query and the analyst\'s statuses (proposed too) to loadPeople, and answers its result', async () => {
    queryOne.mockResolvedValueOnce(unit);
    vi.mocked(loadPeople).mockResolvedValueOnce({ data: [{ key: 'k' }], total: 1, counts: { current: 1, former: 0, all: 1, decide: 0 } });
    const res = await request(app).get(`/api/contexts/${CTX}/people?filter=former&offset=100`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ key: 'k' }], total: 1, counts: { current: 1, former: 0, all: 1, decide: 0 } });
    const [deps, ctx, query, statuses] = vi.mocked(loadPeople).mock.calls[0];
    expect(deps).toBe(PEOPLE_DEPS);
    expect(ctx).toEqual(unit);
    expect(query).toEqual({ filter: 'former', offset: '100' });
    expect(statuses).toEqual(['proposed', 'confirmed', 'edited']);
  });

  it('a context owner (or any reader without data.write.contexts) is answered from confirmed claims only', async () => {
    caller = owner;
    queryOne.mockResolvedValueOnce(unit);
    vi.mocked(loadPeople).mockResolvedValueOnce({ data: [] });
    await request(app).get(`/api/contexts/${CTX}/people`);
    expect(vi.mocked(loadPeople).mock.calls[0][3]).toEqual(['confirmed', 'edited']);
  });

  it('reuses the members endpoint\'s read and the roles read', () => {
    expect(PEOPLE_DEPS.loadMembers).toBe(loadMembers);
    expect(PEOPLE_DEPS.loadRoles).toBe(loadContextRoles);
  });

  it('a bad id is 400, a missing context 404, a context that is not a unit or an application 400 — none reach loadPeople', async () => {
    expect((await request(app).get('/api/contexts/nope/people')).status).toBe(400);
    queryOne.mockResolvedValueOnce(null);
    expect((await request(app).get(`/api/contexts/${CTX}/people`)).status).toBe(404);
    queryOne.mockResolvedValueOnce({ ...unit, contextCategory: 'Tag' });
    const tag = await request(app).get(`/api/contexts/${CTX}/people`);
    expect([tag.status, tag.body.error]).toEqual([400, 'The people overview is for an organizational unit or a logical application.']);
    expect(loadPeople).not.toHaveBeenCalled();
  });

  it('while organisation knowledge is off: the plain overview of listed members, no claims read', async () => {
    orgKnowledge = false;
    queryOne.mockResolvedValueOnce(unit);
    vi.mocked(loadListedPeople).mockResolvedValueOnce({ data: [{ key: 'listed' }], total: 1 });
    const res = await request(app).get(`/api/contexts/${CTX}/people?filter=current`);
    expect(res.body).toEqual({ data: [{ key: 'listed' }], total: 1 });
    expect(loadPeople).not.toHaveBeenCalled();
    const [deps, ctx, query] = vi.mocked(loadListedPeople).mock.calls[0];
    expect(deps).toBe(LISTED_PEOPLE_DEPS);
    expect(ctx).toEqual(unit);
    expect(query).toEqual({ filter: 'current' });
    expect(LISTED_PEOPLE_DEPS.loadRoles).toBe(loadContextRoles);
    expect(LISTED_PEOPLE_DEPS.loadMembers).not.toBe(loadMembers);
  });

  it('the plain overview reads every listed member, a decision marked former or not, and drops the mark', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'm1', displayName: 'Marked', overrideClaimId: 'c1', overrideSource: 'List', overrideBy: 'a', overrideAt: 'x' }] });
    queryOne.mockResolvedValueOnce({ current: 0, overridden: 1 });
    const out = await LISTED_PEOPLE_DEPS.loadMembers(CTX, 'Principal', { limit: 10, withTotal: true });
    expect(out).toEqual({ rows: [{ id: 'm1', displayName: 'Marked', overridden: null }], total: 1, overriddenCount: 1 });
    expect(query.mock.calls[0][0]).not.toContain('AND o.id IS NULL');
  });

  it('a failure is a generic 500', async () => {
    queryOne.mockResolvedValueOnce(unit);
    vi.mocked(loadPeople).mockRejectedValueOnce(new Error('relation "ContextClaims" does not exist'));
    const res = await request(app).get(`/api/contexts/${CTX}/people`);
    expect([res.status, res.body]).toEqual([500, { error: 'Failed to load the people' }]);
  });
});
