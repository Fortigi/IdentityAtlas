import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';

// Everything that decides who may write, as switches the tests flip.
const world = vi.hoisted(() => ({ auth: true, feature: true, ownerReview: false, owns: false, me: null, asked: [] }));
vi.mock('../../config/authConfig.js', () => ({ isAuthEnabled: () => world.auth }));
vi.mock('../../featureFlags.js', () => ({
  requireFeature: (name) => (_req, res, next) => (name === 'compositionReview' && world.feature ? next() : res.status(404).json({ error: 'This feature is not enabled' })),
}));
vi.mock('../../auth/contextOwnerSetting.js', () => ({ isBusinessRoleOwnerReviewEnabled: async () => world.ownerReview }));
vi.mock('../../auth/resolveMe.js', () => ({ resolveMe: async (user) => { world.me = user; return { principal: { id: 'p-1' }, identity: null }; } }));
vi.mock('../../lib/businessRoleOwners.js', async (orig) => ({
  ...(await orig()),
  answersForBusinessRole: vi.fn(async (me, roleId) => { world.asked.push([me, roleId]); return world.owns; }),
}));
const pictures = vi.hoisted(() => ({ now: null }));
vi.mock('../../lib/businessRoleSnapshot.js', async (orig) => ({ ...(await orig()), takeSnapshot: vi.fn(async () => pictures.now) }));

const { default: router, mayReview } = await import('./businessRoleCompositionReview.js');
const caller = vi.hoisted(() => ({ user: null }));
const app = mountRouterAs(router, () => caller.user);

const ROLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const url = `/api/access-package/${ROLE}/composition-reviews`;
const FIN = { id: 'g1', displayName: 'SG-Finance' };
const picture = (resources) => ({ version: 1, type: { control: 'Manual' }, resources, policies: [] });
const SIGNER = { email: 'ann@example.test', name: 'Ann Analyst', permissions: new Set(['data.write.certifications']) };
const READER = { email: 'carla@example.test', name: 'Carla Cash', permissions: new Set(['data.read']) };

function roleExists() {
  queryOne.mockImplementation(async (sql) => (/"resourceType" = 'BusinessRole'/.test(sql) ? { id: ROLE } : null));
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  Object.assign(world, { auth: true, feature: true, ownerReview: false, owns: false, me: null, asked: [] });
  caller.user = SIGNER;
  pictures.now = picture([FIN]);
});

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

  it('gives the reviews, the role now, what changed since the latest sign-off, and that the caller may review', async () => {
    roleExists();
    query.mockResolvedValue({ rows: [{ id: 'r1', signedOff: true, notes: '', reviewedBy: 'bob@example.test', snapshot: picture([]) }] });
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body.current).toEqual(picture([FIN]));
    expect(res.body.latestSignOff).toMatchObject({ id: 'r1', reviewedBy: 'bob@example.test', changesSince: { added: ['SG-Finance'], removed: [] } });
    expect(res.body.canReview).toBe(true);
  });

  it('says a reader who does not answer for the role may not review', async () => {
    roleExists();
    caller.user = READER;
    query.mockResolvedValue({ rows: [] });
    expect((await request(app).get(url)).body.canReview).toBe(false);
  });

  it('500 when the reviews cannot be read', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).get(url)).status).toBe(500);
  });
});

describe('saving', () => {
  it('stores the notes, sign-off and snapshot under the signed-in user, not one from the body', async () => {
    roleExists();
    query.mockResolvedValue({ rows: [{ id: 'new', signedOff: true }] });
    const res = await request(app).post(url).send({ notes: 'All four groups belong here.', signedOff: true, reviewedBy: 'mallory' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'new', signedOff: true });
    const insert = query.mock.calls.find(([sql]) => /INSERT INTO/.test(sql))[1];
    expect(insert).toEqual([ROLE, 'All four groups belong here.', true, 'ann@example.test', 'Ann Analyst', JSON.stringify(picture([FIN]))]);
  });

  it('lets the role\'s own Accountable save, under their own name', async () => {
    roleExists();
    Object.assign(world, { ownerReview: true, owns: true });
    caller.user = READER;
    query.mockResolvedValue({ rows: [{ id: 'new' }] });
    expect((await request(app).post(url).send({ signedOff: true })).status).toBe(201);
    const insert = query.mock.calls.find(([sql]) => /INSERT INTO/.test(sql))[1];
    expect(insert.slice(3, 5)).toEqual(['carla@example.test', 'Carla Cash']);
  });

  it('stores "unknown" when the request carries no user (auth off)', async () => {
    roleExists();
    world.auth = false;
    caller.user = undefined;
    query.mockResolvedValue({ rows: [{ id: 'new' }] });
    await request(app).post(url).send({ signedOff: true });
    const insert = query.mock.calls.find(([sql]) => /INSERT INTO/.test(sql))[1];
    expect(insert.slice(3, 5)).toEqual(['unknown', null]);
  });

  it('400 for a review that says nothing, before touching the database', async () => {
    roleExists();
    const res = await request(app).post(url).send({ notes: ' ', signedOff: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Write a note or sign off');
    expect(query).not.toHaveBeenCalled();
  });

  it('403 naming the permission for someone who may not review, before the flag or the role are looked at', async () => {
    caller.user = READER;
    world.feature = false;
    const res = await request(app).post(url).send({ signedOff: true });
    expect(res.status).toBe(403);
    expect(res.body.required).toEqual(['data.write.certifications']);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404 for someone who may review while the feature is off', async () => {
    world.feature = false;
    expect((await request(app).post(url).send({ signedOff: true })).status).toBe(404);
  });

  it('500 when deciding who may review fails', async () => {
    Object.assign(world, { ownerReview: true });
    caller.user = READER;
    const owners = await import('../../lib/businessRoleOwners.js');
    owners.answersForBusinessRole.mockRejectedValueOnce(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).post(url).send({ signedOff: true })).status).toBe(500);
  });

  it('500 when the review cannot be saved', async () => {
    roleExists();
    query.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).post(url).send({ signedOff: true })).status).toBe(500);
  });
});
