import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mountRouter, mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));
vi.mock('../import/activityKeys.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listKeys: vi.fn(async () => ({ data: [{ id: 'k1' }], total: 1 })),
  decideKeyReview: vi.fn(),
}));

import { listKeys, decideKeyReview } from '../import/activityKeys.js';
import router, { readKeyFilters } from './activityKeys.js';

const app = mountRouter(router);
const ID = '0a0a0a0a-1111-4111-8111-111111111111';

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  listKeys.mockClear();
  decideKeyReview.mockReset();
});

describe('gates', () => {
  it.each([
    ['get', '/api/org-truth/activity-keys', 'data.read'],
    ['put', `/api/org-truth/activity-keys/${ID}`, 'data.write.contexts'],
  ])('%s %s needs %s', async (method, path, perm) => {
    const r = await request(app)[method](path).set('x-deny', perm);
    expect(r.status).toBe(403);
  });
  it('404 while the feature is off', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get('/api/org-truth/activity-keys')).status).toBe(404);
  });
});

describe('readKeyFilters', () => {
  it('empty values are no filter; page defaults to 1', () => {
    expect(readKeyFilters({ status: '', role: '', profileName: '' })).toEqual({ status: null, role: null, profileName: null, page: 1 });
    expect(readKeyFilters({ status: 'unmatched', role: 'subject', profileName: 'Hours', page: '2' })).toEqual({ status: 'unmatched', role: 'subject', profileName: 'Hours', page: 2 });
    expect(readKeyFilters(undefined)).toEqual({ status: null, role: null, profileName: null, page: 1 });
  });
  it.each([
    [{ status: 'open' }, 'status must be one of proposed, accepted, rejected, unmatched.'],
    [{ role: 'owner' }, 'role must be one of actor, subject.'],
    [{ page: '0' }, 'page must be a whole number from 1.'],
    [{ page: '1.5' }, 'page must be a whole number from 1.'],
    [{ page: 'x' }, 'page must be a whole number from 1.'],
  ])('%j → %s', (q, error) => expect(readKeyFilters(q)).toEqual({ error }));
});

describe('GET /org-truth/activity-keys', () => {
  it('answers the list with the filters read from the query', async () => {
    const r = await request(app).get('/api/org-truth/activity-keys?status=proposed&page=2');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [{ id: 'k1' }], total: 1 });
    expect(listKeys).toHaveBeenCalledWith({ status: 'proposed', role: null, profileName: null, page: 2 });
  });
  it('400 for a bad filter, without a query', async () => {
    const r = await request(app).get('/api/org-truth/activity-keys?role=x');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('role must be one of actor, subject.');
    expect(listKeys).not.toHaveBeenCalled();
  });
});

describe('PUT /org-truth/activity-keys/:id', () => {
  it('passes the body and the signed-in analyst, and answers the key', async () => {
    decideKeyReview.mockResolvedValueOnce({ key: { id: ID, status: 'accepted' } });
    const signedIn = mountRouterAs(router, () => ({ preferred_username: 'ann@contoso.com' }));
    const r = await request(signedIn).put(`/api/org-truth/activity-keys/${ID}`).send({ status: 'accepted' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: ID, status: 'accepted' });
    expect(decideKeyReview).toHaveBeenCalledWith(ID, { status: 'accepted' }, 'ann@contoso.com');
  });
  it('answers the decision\'s error with its status', async () => {
    decideKeyReview.mockResolvedValueOnce({ status: 404, error: 'Activity key not found.' });
    const r = await request(app).put(`/api/org-truth/activity-keys/${ID}`).send({ status: 'rejected' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Activity key not found.' });
  });
});
