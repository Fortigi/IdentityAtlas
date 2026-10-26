// GET /api/contexts/:id/people — the route around loadPeople (whose rules are
// contexts/interviews/people*.test.js): its guards, the reader narrowing, and the
// dependencies it hands over (the members endpoint's own read and the roles read).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';
vi.mock('../../db/connection.js');
import { queryOne } from '../../db/connection.js';
let authOn = true;
vi.mock('../../config/authConfig.js', () => ({ isAuthEnabled: () => authOn }));
vi.mock('../../contexts/interviews/peopleLoad.js', () => ({ loadPeople: vi.fn() }));
const { loadPeople } = await import('../../contexts/interviews/peopleLoad.js');
const { default: router, PEOPLE_DEPS, loadMembers } = await import('./read.js');
const { loadContextRoles } = await import('./roles.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const analyst = { email: 'analyst@example.test', permissions: ['data.read', 'data.write.contexts'] };
const owner = { email: 'owner@example.test', contextOwner: { contextIds: new Set([CTX]) }, permissions: [] };
let caller = analyst;
const app = mountRouterAs(router, () => caller);
const unit = { id: CTX, targetType: 'Principal', contextCategory: 'OrganizationalUnit' };

beforeEach(() => {
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

  it('a failure is a generic 500', async () => {
    queryOne.mockResolvedValueOnce(unit);
    vi.mocked(loadPeople).mockRejectedValueOnce(new Error('relation "ContextClaims" does not exist'));
    const res = await request(app).get(`/api/contexts/${CTX}/people`);
    expect([res.status, res.body]).toEqual([500, { error: 'Failed to load the people' }]);
  });
});
