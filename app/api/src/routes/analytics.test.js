import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

vi.mock('../db/connection.js');
vi.mock('../analytics/fields.js', async (orig) => ({ ...(await orig()), listFields: vi.fn(async () => [{ id: 'Principal.accountEnabled' }]) }));
vi.mock('../analytics/profileChecks.js', () => ({ checkAgainstData: vi.fn() }));
vi.mock('../analytics/profileStore.js', () => ({
  listProfiles: vi.fn(), getProfile: vi.fn(), listVersions: vi.fn(), createProfile: vi.fn(), updateProfile: vi.fn(),
}));
vi.mock('../analytics/aggregator.js', async (orig) => ({ ...(await orig()), runDataset: vi.fn() }));

import { checkAgainstData } from '../analytics/profileChecks.js';
import { getProfile, listProfiles, listVersions, createProfile, updateProfile } from '../analytics/profileStore.js';
import { runDataset } from '../analytics/aggregator.js';
import { AnalyticsError } from '../analytics/shaping.js';
import router from './analytics.js';

const app = mountRouter(router);
const api = () => request(app);
const ID = '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab';
const BODY = {
  name: 'Workforce',
  definition: {
    dimensions: [{ field: 'Principal.accountEnabled' }],
    datasets: [{ id: 'a', metric: 'principals.count', dimensions: ['Principal.accountEnabled'] }],
  },
};
const STORED = { id: ID, name: 'Workforce', description: null, status: 'active', version: 2, definition: { datasets: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEATURE_ANALYTICS = 'true';
  checkAgainstData.mockResolvedValue({ errors: [], warnings: [], preview: { dimensions: [], datasets: [] } });
  getProfile.mockResolvedValue(STORED);
});

describe('the feature gate', () => {
  it('answers 404 on every route while analytics is switched off', async () => {
    process.env.FEATURE_ANALYTICS = 'false';
    const routes = router.stack.filter(l => l.route).flatMap(l =>
      Object.keys(l.route.methods).map(method => [method, `/api${l.route.path.replace(':id', ID).replace(':datasetId', 'a')}`]));
    expect(routes).toHaveLength(10);
    for (const [method, path] of routes) {
      const res = await api()[method](path).send(BODY);
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect(createProfile).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('serves the catalog with metrics, fields and limits', async () => {
    const res = await api().get('/api/analytics/v1/catalog');
    expect(res.status).toBe(200);
    expect(res.body.apiVersion).toBe('analytics/v1');
    expect(res.body.metrics.map(m => m.id)).toContain('assignments.governedShare');
    expect(res.body.fields).toEqual([{ id: 'Principal.accountEnabled' }]);
    expect(res.body.limits.maxDimensionValues).toBe(200);
  });

  it('lists profiles, reads one, its versions and its metadata, and 404s an unknown one', async () => {
    listProfiles.mockResolvedValue([STORED]);
    expect((await api().get('/api/analytics/v1/profiles')).body.data).toEqual([STORED]);
    expect((await api().get(`/api/analytics/v1/profiles/${ID}`)).body).toEqual(STORED);
    listVersions.mockResolvedValue([{ version: 2 }]);
    expect((await api().get(`/api/analytics/v1/profiles/${ID}/versions`)).body).toEqual({ data: [{ version: 2 }] });
    const meta = await api().get(`/api/analytics/v1/profiles/${ID}/metadata`);
    expect(meta.body.profile).toMatchObject({ id: ID, version: 2 });
    getProfile.mockResolvedValue(null);
    const missing = await api().get(`/api/analytics/v1/profiles/${ID}`);
    expect([missing.status, missing.body.code]).toEqual([404, 'not_found']);
  });

  it('returns a dataset uncached, and maps refusals to their status and code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runDataset.mockResolvedValueOnce({ dataset: { id: 'a' }, rowCount: 0, rows: [] });
    const ok = await api().get(`/api/analytics/v1/profiles/${ID}/datasets/a`);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(log.mock.calls[0][0]).toContain(`dataset a of profile ${ID} v2`);
    runDataset.mockRejectedValueOnce(new AnalyticsError(422, 'dataset_too_large', 'too big', { maxRows: 5 }));
    const big = await api().get(`/api/analytics/v1/profiles/${ID}/datasets/a`);
    expect([big.status, big.body]).toEqual([422, { error: 'too big', code: 'dataset_too_large', details: { maxRows: 5 } }]);
    log.mockRestore();
  });

  it('hides internal errors behind a generic message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    runDataset.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    const res = await api().get(`/api/analytics/v1/profiles/${ID}/datasets/a`);
    expect([res.status, res.body]).toEqual([500, { error: 'Request failed', code: 'internal' }]);
    err.mockRestore();
  });
});

describe('configuration', () => {
  it('validates without saving and returns the preview', async () => {
    const res = await api().post('/api/analytics/v1/profiles/validate').send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, preview: { dimensions: [], datasets: [] } });
    expect(createProfile).not.toHaveBeenCalled();
  });

  it('refuses a malformed profile before touching the database', async () => {
    const res = await api().post('/api/analytics/v1/profiles').send({ ...BODY, name: '' });
    expect([res.status, res.body.code]).toEqual([400, 'invalid_profile']);
    expect(res.body.details.errors.map(e => e.path)).toEqual(['name']);
    expect(checkAgainstData).not.toHaveBeenCalled();
  });

  it('refuses a profile that fails the data checks, passing warnings along', async () => {
    checkAgainstData.mockResolvedValue({ errors: [{ path: 'dimensions[0].field', code: 'high_cardinality' }], warnings: [{ code: 'w' }], preview: null });
    const res = await api().post('/api/analytics/v1/profiles').send(BODY);
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ errors: [{ path: 'dimensions[0].field', code: 'high_cardinality' }], warnings: [{ code: 'w' }] });
  });

  it('creates with the normalized definition and the actor', async () => {
    createProfile.mockResolvedValue({ id: ID, version: 1 });
    const res = await api().post('/api/analytics/v1/profiles').send(BODY);
    expect(res.status).toBe(201);
    const [profile, actor] = createProfile.mock.calls[0];
    expect(profile.definition.privacy).toEqual({ minGroupSize: 5 });
    expect(actor).toBe('unknown');
  });

  it('requires expectedVersion on update and passes it through', async () => {
    const missing = await api().put(`/api/analytics/v1/profiles/${ID}`).send(BODY);
    expect(missing.status).toBe(400);
    expect(updateProfile).not.toHaveBeenCalled();
    updateProfile.mockResolvedValue({ id: ID, version: 3 });
    const ok = await api().put(`/api/analytics/v1/profiles/${ID}`).send({ ...BODY, expectedVersion: 2 });
    expect(ok.status).toBe(200);
    expect(updateProfile.mock.calls[0][2]).toBe(2);
  });

  it('surfaces a version conflict as 409 with the current version', async () => {
    updateProfile.mockRejectedValue(new AnalyticsError(409, 'version_conflict', 'stale', { currentVersion: 4 }));
    const res = await api().put(`/api/analytics/v1/profiles/${ID}`).send({ ...BODY, expectedVersion: 2 });
    expect([res.status, res.body.code, res.body.details]).toEqual([409, 'version_conflict', { currentVersion: 4 }]);
  });

  it('retires instead of deleting, as a new version of the current one', async () => {
    updateProfile.mockResolvedValue({ ...STORED, status: 'retired', version: 3 });
    const res = await api().delete(`/api/analytics/v1/profiles/${ID}`);
    expect(res.body.status).toBe('retired');
    const [id, profile, expectedVersion] = updateProfile.mock.calls[0];
    expect([id, profile.status, profile.definition, expectedVersion]).toEqual([ID, 'retired', STORED.definition, 2]);
  });

  it('answers 500 with no detail when any route fails unexpectedly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = () => Promise.reject(new Error('connection reset'));
    listProfiles.mockImplementation(boom);
    getProfile.mockImplementation(boom);
    checkAgainstData.mockImplementation(boom);
    const { listFields } = await import('../analytics/fields.js');
    listFields.mockImplementationOnce(boom);
    const calls = [
      ['get', '/api/analytics/v1/catalog'], ['get', '/api/analytics/v1/profiles'],
      ['post', '/api/analytics/v1/profiles/validate'], ['post', '/api/analytics/v1/profiles'],
      ['get', `/api/analytics/v1/profiles/${ID}`], ['get', `/api/analytics/v1/profiles/${ID}/versions`],
      ['put', `/api/analytics/v1/profiles/${ID}`], ['delete', `/api/analytics/v1/profiles/${ID}`],
      ['get', `/api/analytics/v1/profiles/${ID}/metadata`],
    ];
    for (const [method, path] of calls) {
      const res = await api()[method](path).send({ ...BODY, expectedVersion: 1 });
      expect([path, res.status, res.body]).toEqual([path, 500, { error: 'Request failed', code: 'internal' }]);
    }
    expect(err.mock.calls.map(c => c[0])).toEqual([
      'analytics catalog failed:', 'analytics list failed:', 'analytics validate failed:', 'analytics create failed:',
      'analytics get failed:', 'analytics versions failed:', 'analytics update failed:', 'analytics retire failed:',
      'analytics metadata failed:',
    ]);
    err.mockRestore();
  });

  it('names the signed-in user, or the read token, as the actor', async () => {
    const { mountRouterAs } = await import('../../test-utils/routeTestKit.js');
    const asUser = mountRouterAs(router, () => ({ email: 'ann@example.com' }));
    createProfile.mockResolvedValue({ id: ID, version: 1 });
    await request(asUser).post('/api/analytics/v1/profiles').send(BODY);
    expect(createProfile.mock.calls[0][1]).toBe('ann@example.com');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const express = (await import('express')).default;
    const asToken = express();
    asToken.use((req, _res, next) => { req.readToken = { id: 1, name: 'powerbi' }; next(); });
    asToken.use('/api', router);
    runDataset.mockResolvedValueOnce({ dataset: { id: 'a' }, rowCount: 3, rows: [] });
    await request(asToken).get(`/api/analytics/v1/profiles/${ID}/datasets/a`);
    expect(log.mock.calls[0][0]).toBe(`analytics: read token "powerbi" read dataset a of profile ${ID} v2 (3 rows)`);
    log.mockRestore();
  });

  it('leaves an already retired profile alone', async () => {
    getProfile.mockResolvedValue({ ...STORED, status: 'retired' });
    const res = await api().delete(`/api/analytics/v1/profiles/${ID}`);
    expect(res.body.status).toBe('retired');
    expect(updateProfile).not.toHaveBeenCalled();
  });
});
