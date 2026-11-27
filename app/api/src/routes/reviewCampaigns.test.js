import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../test-utils/routeTestKit.js';

const world = vi.hoisted(() => ({ auth: true, feature: true, policy: null, me: null }));
vi.mock('../config/authConfig.js', async (orig) => ({ ...(await orig()), isAuthEnabled: () => world.auth }));
vi.mock('../featureFlags.js', () => ({
  requireFeature: (name) => (_req, res, next) => (name === 'compositionReview' && world.feature ? next() : res.status(404).json({ error: 'This feature is not enabled' })),
}));
vi.mock('../auth/contextOwnerSetting.js', async () => {
  const { normalizePolicy } = await import('../auth/relativePermissions.js');
  return { getRelativePolicy: async () => normalizePolicy(world.policy ?? {}) };
});
vi.mock('../auth/resolveMe.js', () => ({ resolveMe: async (user) => { world.me = user; return { principal: { id: 'p-1' }, identity: null }; } }));
vi.mock('../lib/reviewCampaigns.js', async (orig) => ({
  ...(await orig()),
  listCampaigns: vi.fn(), loadCampaign: vi.fn(), createCampaign: vi.fn(), endCampaign: vi.fn(), deleteCampaign: vi.fn(),
  scopeOptions: vi.fn(), openRequestsFor: vi.fn(),
}));

const lib = await import('../lib/reviewCampaigns.js');
const { default: router, askedCanOpen, CAMPAIGN_PERMISSION } = await import('./reviewCampaigns.js');
const caller = vi.hoisted(() => ({ user: null, readToken: false }));
const app = mountRouterAs(router, (req) => { if (caller.readToken) req.readToken = true; return caller.user; });

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROLE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANAGER = { email: 'ann@example.test', name: 'Ann', permissions: new Set(['data.write.review-campaigns']) };
const READER = { email: 'carla@example.test', name: 'Carla', permissions: new Set(['data.read']) };
const BODY = { name: 'Yearly role review', steps: ['contents'], roleIds: [ROLE], startsOn: '2026-12-01', intervalMonths: null, dueDays: 30 };

beforeEach(() => {
  for (const fn of Object.values(lib)) if (vi.isMockFunction(fn)) fn.mockReset();
  Object.assign(world, { auth: true, feature: true, policy: null, me: null });
  Object.assign(caller, { user: MANAGER, readToken: false });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('who may manage campaigns', () => {
  const calls = [
    ['get', '/api/review-campaigns'], ['get', '/api/review-campaigns/scope-options'], ['post', '/api/review-campaigns'],
    ['get', `/api/review-campaigns/${ID}`], ['post', `/api/review-campaigns/${ID}/end`], ['delete', `/api/review-campaigns/${ID}`],
  ];

  it('names the permission it gates on', () => {
    expect(CAMPAIGN_PERMISSION).toBe('data.write.review-campaigns');
  });

  it.each(calls)('refuses %s %s without the permission, before the flag is looked at', async (method, url) => {
    caller.user = READER;
    world.feature = false;
    expect((await request(app)[method](url).send(BODY)).status).toBe(403);
  });

  it.each(calls)('answers %s %s with 404 while the feature is off', async (method, url) => {
    world.feature = false;
    expect((await request(app)[method](url).send(BODY)).status).toBe(404);
    expect(lib.listCampaigns).not.toHaveBeenCalled();
    expect(lib.createCampaign).not.toHaveBeenCalled();
    expect(lib.deleteCampaign).not.toHaveBeenCalled();
  });
});

describe('askedCanOpen', () => {
  it('follows the grid: the Accountable needs view on the Business roles row', async () => {
    expect(await askedCanOpen()).toBe(false);
    world.policy = { BusinessRole: { Responsible: { view: true } } };
    expect(await askedCanOpen()).toBe(false);
    world.policy = { BusinessRole: { Accountable: { view: true } } };
    expect(await askedCanOpen()).toBe(true);
  });

  it('is true while sign-in is off: everybody can open everything', async () => {
    world.auth = false;
    expect(await askedCanOpen()).toBe(true);
  });
});

describe('listing', () => {
  it('gives the campaigns and whether the people asked can open their role', async () => {
    lib.listCampaigns.mockResolvedValue([{ id: ID, name: 'Yearly' }]);
    const res = await request(app).get('/api/review-campaigns');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ campaigns: [{ id: ID, name: 'Yearly' }], askedCanOpen: false });
  });

  it('gives the roles and portfolios to choose from', async () => {
    lib.scopeOptions.mockResolvedValue({ roles: [{ id: ROLE }], portfolios: [] });
    expect((await request(app).get('/api/review-campaigns/scope-options')).body).toEqual({ roles: [{ id: ROLE }], portfolios: [] });
  });

  it('500 when either cannot be read', async () => {
    lib.listCampaigns.mockRejectedValue(new Error('down'));
    lib.scopeOptions.mockRejectedValue(new Error('down'));
    expect((await request(app).get('/api/review-campaigns')).status).toBe(500);
    expect((await request(app).get('/api/review-campaigns/scope-options')).status).toBe(500);
  });
});

describe('creating', () => {
  it('saves the parsed campaign under the signed-in user and answers with it', async () => {
    lib.createCampaign.mockResolvedValue({ id: ID });
    lib.loadCampaign.mockResolvedValue({ id: ID, name: 'Yearly role review' });
    const res = await request(app).post('/api/review-campaigns').send({ ...BODY, createdBy: 'mallory' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: ID, name: 'Yearly role review' });
    expect(lib.createCampaign).toHaveBeenCalledWith(
      { name: 'Yearly role review', steps: ['contents'], roleIds: [ROLE], portfolioIds: [], startsOn: '2026-12-01', intervalMonths: null, dueDays: 30 },
      'ann@example.test',
    );
    expect(lib.loadCampaign).toHaveBeenCalledWith(ID);
  });

  it('400 with the reason for a campaign that is not complete, before saving', async () => {
    const res = await request(app).post('/api/review-campaigns').send({ ...BODY, steps: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Choose at least one step to review');
    expect(lib.createCampaign).not.toHaveBeenCalled();
  });

  it('400 when nothing in the scope exists', async () => {
    lib.createCampaign.mockResolvedValue({ error: 'None of the chosen business roles or role portfolios exist any more' });
    const res = await request(app).post('/api/review-campaigns').send(BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^None of the chosen/);
    expect(lib.loadCampaign).not.toHaveBeenCalled();
  });

  it('500 when it cannot be saved', async () => {
    lib.createCampaign.mockRejectedValue(new Error('down'));
    expect((await request(app).post('/api/review-campaigns').send(BODY)).status).toBe(500);
  });
});

describe('one campaign', () => {
  it('400 for an id that is not one, on every route that takes one', async () => {
    expect((await request(app).get('/api/review-campaigns/nope')).status).toBe(400);
    expect((await request(app).post('/api/review-campaigns/nope/end')).status).toBe(400);
    expect((await request(app).delete('/api/review-campaigns/nope')).status).toBe(400);
    expect(lib.loadCampaign).not.toHaveBeenCalled();
  });

  it('gives it, or 404 when there is none', async () => {
    lib.loadCampaign.mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce(null);
    expect((await request(app).get(`/api/review-campaigns/${ID}`)).body).toEqual({ id: ID });
    expect((await request(app).get(`/api/review-campaigns/${ID}`)).status).toBe(404);
  });

  it('ends a running campaign and answers with how it stands now', async () => {
    lib.endCampaign.mockResolvedValue(true);
    lib.loadCampaign.mockResolvedValue({ id: ID, status: 'ended' });
    const res = await request(app).post(`/api/review-campaigns/${ID}/end`);
    expect(res.body).toEqual({ id: ID, status: 'ended' });
    expect(lib.endCampaign).toHaveBeenCalledWith(ID);
  });

  it('404 when there is no running campaign to end', async () => {
    lib.endCampaign.mockResolvedValue(false);
    expect((await request(app).post(`/api/review-campaigns/${ID}/end`)).status).toBe(404);
    expect(lib.loadCampaign).not.toHaveBeenCalled();
  });

  it('removes it with 204, or 404 when there is none', async () => {
    lib.deleteCampaign.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await request(app).delete(`/api/review-campaigns/${ID}`)).status).toBe(204);
    expect((await request(app).delete(`/api/review-campaigns/${ID}`)).status).toBe(404);
  });

  it('500 when the database fails', async () => {
    lib.loadCampaign.mockRejectedValue(new Error('down'));
    lib.endCampaign.mockRejectedValue(new Error('down'));
    lib.deleteCampaign.mockRejectedValue(new Error('down'));
    expect((await request(app).get(`/api/review-campaigns/${ID}`)).status).toBe(500);
    expect((await request(app).post(`/api/review-campaigns/${ID}/end`)).status).toBe(500);
    expect((await request(app).delete(`/api/review-campaigns/${ID}`)).status).toBe(500);
  });
});

describe('what the caller is asked', () => {
  const mine = '/api/review-requests/mine';

  it('lists the caller\'s own requests, without any permission', async () => {
    caller.user = READER;
    lib.openRequestsFor.mockResolvedValue([{ id: 'q-1', roleId: ROLE }]);
    const res = await request(app).get(mine);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [{ id: 'q-1', roleId: ROLE }] });
    expect(world.me).toBe(READER);
    expect(lib.openRequestsFor).toHaveBeenCalledWith({ principal: { id: 'p-1' }, identity: null });
  });

  it('uses the person owner mode already matched', async () => {
    const known = { principal: { id: 'p-owner' }, identity: null };
    caller.user = { ...READER, contextOwner: { me: known } };
    lib.openRequestsFor.mockResolvedValue([]);
    await request(app).get(mine);
    expect(lib.openRequestsFor).toHaveBeenCalledWith(known);
    expect(world.me).toBeNull();
  });

  it('is empty for a read API key and for nobody, without looking anyone up', async () => {
    caller.readToken = true;
    expect((await request(app).get(mine)).body).toEqual({ requests: [] });
    Object.assign(caller, { readToken: false, user: undefined });
    expect((await request(app).get(mine)).body).toEqual({ requests: [] });
    expect(lib.openRequestsFor).not.toHaveBeenCalled();
  });

  it('404 while the feature is off, 500 when it cannot be read', async () => {
    caller.user = READER;
    world.feature = false;
    expect((await request(app).get(mine)).status).toBe(404);
    world.feature = true;
    lib.openRequestsFor.mockRejectedValue(new Error('down'));
    expect((await request(app).get(mine)).status).toBe(500);
  });
});
