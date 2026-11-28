import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
import { query, queryOne, tx } from '../../db/connection.js';

// Everything that decides who may write, as switches the tests flip.
// ownerReview: the grid gives both owner roles review (as the old switch did);
// policy: a grid of its own instead. roles: the owner roles the lookup was asked for.
const world = vi.hoisted(() => ({ auth: true, feature: true, ownerReview: false, policy: null, owns: false, me: null, asked: [], roles: null }));
vi.mock('../../config/authConfig.js', () => ({ isAuthEnabled: () => world.auth }));
vi.mock('../../featureFlags.js', () => ({
  requireFeature: (name) => (_req, res, next) => (name === 'compositionReview' && world.feature ? next() : res.status(404).json({ error: 'This feature is not enabled' })),
}));
vi.mock('../../auth/contextOwnerSetting.js', async () => {
  const { legacyPolicy } = await import('../../auth/relativePermissions.js');
  return { getRelativePolicy: async () => world.policy ?? legacyPolicy({ ownerReview: world.ownerReview }) };
});
vi.mock('../../auth/resolveMe.js', () => ({ resolveMe: async (user) => { world.me = user; return { principal: { id: 'p-1' }, identity: null }; } }));
vi.mock('../../lib/businessRoleOwners.js', async (orig) => ({
  ...(await orig()),
  answersForBusinessRole: vi.fn(async (me, roleId, roles) => { world.asked.push([me, roleId]); world.roles = roles; return world.owns; }),
}));
// What review campaigns ask of the caller for this role, and what a saved review answered.
const campaigns = vi.hoisted(() => ({ open: [], lookedUp: [], answered: [] }));
vi.mock('../../lib/reviewCampaigns.js', () => ({
  openRequestsFor: async (me, roleId) => { campaigns.lookedUp.push([me, roleId]); return campaigns.open; },
  answerRequests: async (me, roleId, review) => { campaigns.answered.push([me, roleId, review.id]); return campaigns.open.length; },
}));
const pictures = vi.hoisted(() => ({ now: null }));
const mining = vi.hoisted(() => ({ result: null, fail: null, calls: [] }));
vi.mock('../../lib/roleImprovements.js', () => ({
  findImprovements: async (roleId) => { mining.calls.push(roleId); if (mining.fail) throw mining.fail; return mining.result; },
}));
vi.mock('../../lib/businessRoleSnapshot.js', async (orig) => ({ ...(await orig()), takeSnapshot: vi.fn(async () => pictures.now) }));

const { default: router, mayReview, askedRequests } = await import('./businessRoleCompositionReview.js');
const caller = vi.hoisted(() => ({ user: null }));
const app = mountRouterAs(router, () => caller.user);

const ROLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const url = `/api/access-package/${ROLE}/composition-reviews`;
const FIN = { id: 'g1', displayName: 'SG-Finance' };
const picture = (resources) => ({ version: 2, type: { control: 'Manual' }, resources, policies: [], owners: [] });
const SIGNER = { email: 'ann@example.test', name: 'Ann Analyst', permissions: new Set(['data.write.certifications']) };
const READER = { email: 'carla@example.test', name: 'Carla Cash', permissions: new Set(['data.read']) };

function roleExists() {
  queryOne.mockImplementation(async (sql) => (/"resourceType" = 'BusinessRole'/.test(sql) ? { id: ROLE } : null));
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  Object.assign(world, { auth: true, feature: true, ownerReview: false, policy: null, owns: false, me: null, asked: [], roles: null });
  caller.user = SIGNER;
  pictures.now = picture([FIN]);
  Object.assign(campaigns, { open: [], lookedUp: [], answered: [] });
});

const ME = { principal: { id: 'p-1' }, identity: null };
const REQUEST = { id: 'q-1', roleId: ROLE, campaignName: 'Yearly role review', steps: ['contents'], dueAt: '2026-12-31T23:59:59Z', overdue: false };

describe('mayReview', () => {
  const as = (user, readToken = false) => ({ user, readToken, params: { id: ROLE } });

  it('lets everybody in while sign-in is off', async () => {
    world.auth = false;
    expect(await mayReview(as(undefined))).toBe(true);
  });

  it('never lets a read API key write', async () => {
    expect(await mayReview(as({ permissions: new Set(['*']) }, true))).toBe(false);
  });

  it('lets in the certification permission and the wildcard, without looking the caller up', async () => {
    expect(await mayReview(as(SIGNER))).toBe(true);
    expect(await mayReview(as({ permissions: new Set(['*']) }))).toBe(true);
    expect(world.asked).toEqual([]);
  });

  it('asks nothing about ownership while the relative permission is off', async () => {
    world.owns = true;
    expect(await mayReview(as(READER))).toBe(false);
    expect(world.asked).toEqual([]);
  });

  it('with the relative permission on, lets in the role\'s own Accountable or Responsible — and nobody else', async () => {
    world.ownerReview = true;
    expect(await mayReview(as(READER))).toBe(false);
    expect(world.asked).toEqual([[{ principal: { id: 'p-1' }, identity: null }, ROLE]]);
    expect(world.me).toBe(READER);
    world.owns = true;
    expect(await mayReview(as(READER))).toBe(true);
    expect(world.roles).toEqual(['Accountable', 'Responsible']);
  });

  it('asks only for the owner roles the grid gives review — Accountable alone here', async () => {
    const { normalizePolicy } = await import('../../auth/relativePermissions.js');
    world.policy = normalizePolicy({ BusinessRole: { Accountable: { review: true } } });
    world.owns = true;
    expect(await mayReview(as(READER))).toBe(true);
    expect(world.roles).toEqual(['Accountable']);
  });

  it('uses the person owner mode already matched, instead of looking them up again', async () => {
    world.ownerReview = true;
    const known = { principal: { id: 'p-owner' }, identity: null };
    await mayReview(as({ ...READER, contextOwner: { me: known } }));
    expect(world.asked).toEqual([[known, ROLE]]);
    expect(world.me).toBeNull();
  });

  it('lets in whoever a review campaign asks, also while the grid gives nobody review', async () => {
    expect(await mayReview(as(READER))).toBe(false);
    expect(campaigns.lookedUp).toEqual([[ME, ROLE]]);
    campaigns.open = [REQUEST];
    expect(await mayReview(as(READER))).toBe(true);
    // Ownership was never asked: the grid gives no role review.
    expect(world.asked).toEqual([]);
  });

  it('does not ask the campaigns for someone the grid already lets in, and looks the person up once', async () => {
    Object.assign(world, { ownerReview: true, owns: true });
    const req = as(READER);
    expect(await mayReview(req)).toBe(true);
    expect(campaigns.lookedUp).toEqual([]);
    world.me = null;
    await askedRequests(req);
    expect(world.me).toBeNull();
    expect(campaigns.lookedUp).toEqual([[ME, ROLE]]);
  });

  it('finds no campaign request for a read API key, for nobody, or while sign-in is off', async () => {
    campaigns.open = [REQUEST];
    expect(await askedRequests(as(READER, true))).toEqual([]);
    expect(await askedRequests(as(undefined))).toEqual([]);
    world.auth = false;
    expect(await askedRequests(as(READER))).toEqual([]);
    expect(campaigns.lookedUp).toEqual([]);
    world.auth = true;
    expect(await askedRequests(as(READER))).toEqual([REQUEST]);
  });

  it('looks an owner up also when the caller carries no permissions at all', async () => {
    Object.assign(world, { ownerReview: true, owns: true });
    expect(await mayReview(as({ email: 'x@example.test' }))).toBe(true);
  });
});

describe('reading', () => {
  it('400 on a malformed id, 404 for something that is not a business role', async () => {
    expect((await request(app).get('/api/access-package/nope/composition-reviews')).status).toBe(400);
    queryOne.mockResolvedValue(null);
    expect((await request(app).get(url)).status).toBe(404);
  });

  it('404 while the feature is off, before the role is looked up', async () => {
    world.feature = false;
    expect((await request(app).get(url)).status).toBe(404);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('gives the reviews with what each found, the role now, what changed since the latest, and that the caller may review', async () => {
    roleExists();
    query.mockResolvedValue({ rows: [{ id: 'r1', notes: '', reviewedBy: 'bob@example.test', snapshot: picture([]), steps: [{ step: 'contents', verdict: 'needsChange', remark: 'x', proposal: null }] }] });
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body.current).toEqual(picture([FIN]));
    expect(res.body.reviews[0].outcome).toBe('findings');
    expect(res.body.latestReview).toMatchObject({ id: 'r1', reviewedBy: 'bob@example.test', outcome: 'findings', changesSince: { added: ['SG-Finance'], removed: [] } });
    expect(res.body.steps).toEqual(['ownership', 'lifecycle', 'contents', 'improvements']);
    expect(res.body.canReview).toBe(true);
  });

  it('says a reader who does not answer for the role may not review', async () => {
    roleExists();
    caller.user = READER;
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get(url);
    expect(res.body.canReview).toBe(false);
    expect(res.body.request).toBeNull();
  });

  it('tells someone a campaign asks what they are asked, soonest due first, and that they may review', async () => {
    roleExists();
    caller.user = READER;
    campaigns.open = [REQUEST, { ...REQUEST, id: 'q-2', campaignName: 'Later' }];
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get(url);
    expect(res.body.canReview).toBe(true);
    expect(res.body.request).toEqual(REQUEST);
  });

  it('500 when the reviews cannot be read', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).get(url)).status).toBe(500);
  });
});

describe('saving', () => {
  const GOOD = { steps: [{ step: 'contents', verdict: 'good' }] };
  const written = () => query.mock.calls.filter(([sql]) => /INSERT INTO/.test(sql));
  beforeEach(() => {
    tx.mockReset();
    tx.mockImplementation(async (fn) => fn({ query }));
  });

  it('stores the steps, notes and snapshot under the signed-in user, not one from the body', async () => {
    roleExists();
    query.mockResolvedValue({ rows: [{ id: 'new', notes: 'All four groups belong here.' }] });
    const res = await request(app).post(url).send({
      steps: [{ step: 'lifecycle', verdict: 'needsChange', remark: 'The approver left.' }, { step: 'ownership', verdict: 'good' }],
      notes: 'All four groups belong here.', reviewedBy: 'mallory',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'new', outcome: 'findings' });
    expect(res.body.steps.map(s => [s.step, s.verdict])).toEqual([['ownership', 'good'], ['lifecycle', 'needsChange']]);
    const [review, first, second] = written().map(([, params]) => params);
    expect(review).toEqual([ROLE, 'All four groups belong here.', 'ann@example.test', 'Ann Analyst', JSON.stringify(picture([FIN]))]);
    expect(first).toEqual(['new', 'ownership', 'good', '', null]);
    expect(second).toEqual(['new', 'lifecycle', 'needsChange', 'The approver left.', null]);
  });

  it('lets the role\'s own Accountable save, under their own name', async () => {
    roleExists();
    Object.assign(world, { ownerReview: true, owns: true });
    caller.user = READER;
    query.mockResolvedValue({ rows: [{ id: 'new' }] });
    expect((await request(app).post(url).send(GOOD)).status).toBe(201);
    expect(written()[0][1].slice(2, 4)).toEqual(['carla@example.test', 'Carla Cash']);
  });

  it('answers the campaign requests of the reviewer with the saved review', async () => {
    roleExists();
    caller.user = READER;
    campaigns.open = [REQUEST];
    query.mockResolvedValue({ rows: [{ id: 'new' }] });
    expect((await request(app).post(url).send(GOOD)).status).toBe(201);
    expect(campaigns.answered).toEqual([[ME, ROLE, 'new']]);
  });

  it('answers no campaign request when the review was refused', async () => {
    roleExists();
    await request(app).post(url).send({ steps: [{ step: 'contents', verdict: 'needsChange' }] });
    expect(campaigns.answered).toEqual([]);
  });

  it('stores "unknown" when the request carries no user (auth off)', async () => {
    roleExists();
    world.auth = false;
    caller.user = undefined;
    query.mockResolvedValue({ rows: [{ id: 'new' }] });
    await request(app).post(url).send(GOOD);
    expect(written()[0][1].slice(2, 4)).toEqual(['unknown', null]);
    // Nobody in particular reviewed, so no campaign request is answered.
    expect(campaigns.answered).toEqual([]);
  });

  it('400 for a review without steps, before touching the database', async () => {
    roleExists();
    const res = await request(app).post(url).send({ notes: 'looks fine' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A review judges at least one step');
    expect(query).not.toHaveBeenCalled();
  });

  it('400 for a change that does not say what, and nothing is written', async () => {
    roleExists();
    const res = await request(app).post(url).send({ steps: [{ step: 'contents', verdict: 'needsChange' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Say what should change/);
    expect(tx).not.toHaveBeenCalled();
  });

  it('403 naming the permission for someone who may not review, before the flag or the role are looked at', async () => {
    caller.user = READER;
    world.feature = false;
    const res = await request(app).post(url).send(GOOD);
    expect(res.status).toBe(403);
    expect(res.body.required).toEqual(['data.write.certifications']);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404 for someone who may review while the feature is off', async () => {
    world.feature = false;
    expect((await request(app).post(url).send(GOOD)).status).toBe(404);
  });

  it('500 when deciding who may review fails', async () => {
    Object.assign(world, { ownerReview: true });
    caller.user = READER;
    const owners = await import('../../lib/businessRoleOwners.js');
    owners.answersForBusinessRole.mockRejectedValueOnce(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).post(url).send(GOOD)).status).toBe(500);
  });

  it('500 when the review cannot be saved', async () => {
    roleExists();
    tx.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).post(url).send(GOOD)).status).toBe(500);
  });
});

describe('looking up people to propose', () => {
  const people = `${url}/people`;

  it('gives the reviewer a short list of names for the term', async () => {
    roleExists();
    query.mockResolvedValue({ rows: [{ id: 'p-9', displayName: 'Carla Cash', userPrincipalName: 'carla@example.test' }] });
    const res = await request(app).get(`${people}?search=car`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: 'p-9', displayName: 'Carla Cash', userPrincipalName: 'carla@example.test' }] });
    expect(query.mock.calls[0][1]).toEqual(['%car%']);
  });

  it('gives nobody for no term, or a term that is not text', async () => {
    roleExists();
    expect((await request(app).get(people)).body).toEqual({ data: [] });
    expect((await request(app).get(`${people}?search[]=car&search[]=la`)).body).toEqual({ data: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('is closed to someone who may not review this role, and open to its owner', async () => {
    roleExists();
    caller.user = READER;
    query.mockResolvedValue({ rows: [] });
    expect((await request(app).get(`${people}?search=car`)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
    Object.assign(world, { ownerReview: true, owns: true });
    expect((await request(app).get(`${people}?search=car`)).status).toBe(200);
  });

  it('404 while the feature is off and for something that is not a business role', async () => {
    world.feature = false;
    expect((await request(app).get(`${people}?search=car`)).status).toBe(404);
    world.feature = true;
    queryOne.mockResolvedValue(null);
    expect((await request(app).get(`${people}?search=car`)).status).toBe(404);
  });

  it('500 when the directory cannot be read', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).get(`${people}?search=car`)).status).toBe(500);
  });
});

describe('role-mining suggestions', () => {
  const improvements = `${url}/improvements`;
  const FOUND = { suggestions: [{ key: 'permission:g9', kind: 'addPermission', confidence: 100 }], declinedBefore: 0, handedOutByHand: true, holderCount: 6 };
  beforeEach(() => {
    Object.assign(mining, { result: FOUND, fail: null, calls: [] });
    tx.mockReset();
  });

  it('gives the reviewer what role mining suggests for this role', async () => {
    roleExists();
    const res = await request(app).get(improvements);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(FOUND);
    expect(mining.calls).toEqual([ROLE]);
  });

  it('is closed to someone who may not review this role, and open to its owner', async () => {
    roleExists();
    caller.user = READER;
    expect((await request(app).get(improvements)).status).toBe(403);
    expect(mining.calls).toEqual([]);
    Object.assign(world, { ownerReview: true, owns: true });
    expect((await request(app).get(improvements)).status).toBe(200);
  });

  it('404 while the feature is off and for something that is not a business role', async () => {
    world.feature = false;
    expect((await request(app).get(improvements)).status).toBe(404);
    world.feature = true;
    queryOne.mockResolvedValue(null);
    expect((await request(app).get(improvements)).status).toBe(404);
    expect(mining.calls).toEqual([]);
  });

  it('500 when role mining fails', async () => {
    roleExists();
    mining.fail = new Error('down');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).get(improvements)).status).toBe(500);
  });

  it('saves the decisions on the suggestions as role mining makes them when the review is signed', async () => {
    roleExists();
    tx.mockImplementation(async (fn) => fn({ query: async (sql, params) => ({ rows: [{ id: 'r-9', notes: params[1] }] }) }));
    const res = await request(app).post(url).send({ steps: [{ step: 'improvements', decisions: [{ key: 'permission:g9', decision: 'adopt' }] }] });
    expect(res.status).toBe(201);
    expect(res.body.steps[0]).toMatchObject({ step: 'improvements', verdict: 'needsChange', proposal: { suggestions: [{ key: 'permission:g9', decision: 'adopt' }] } });
    expect(mining.calls).toEqual([ROLE]);
  });

  it('400 when the reviewer decided on suggestions role mining no longer makes', async () => {
    roleExists();
    const res = await request(app).post(url).send({ steps: [{ step: 'improvements', decisions: [{ key: 'permission:gone', decision: 'adopt' }] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/suggestions changed/);
    expect(tx).not.toHaveBeenCalled();
  });
});
