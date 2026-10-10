// The three T10 read routers (enrichment, activity, signals) in one suite: same
// gates, same mocks, so one setup.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));
vi.mock('../../db/connection.js');

import { query, queryOne } from '../../db/connection.js';
import enrichment from './enrichment.js';
import activity from './activity.js';
import signals from './signals.js';
import { SIGNALS_KEY } from '../signals/settings.js';

const app = mountRouter(Router().use(enrichment, activity, signals));
const URL = '/api/org-truth/signals';
const ID = 'c0000000-0000-4000-8000-000000000001';

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue(undefined); // feature flag: no override, env decides
  query.mockResolvedValue({ rows: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('gates', () => {
  it.each([
    ['get', `${URL}/settings`, 'data.read'],
    ['put', `${URL}/settings`, 'data.write.contexts'],
    ['get', `${URL}?type=Klant`, 'data.read'],
  ])('%s %s needs %s', async (method, url, perm) => {
    const r = await request(app)[method](url).set('x-deny', perm).send({});
    expect(r.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('a reader may read the settings but not save them', async () => {
    query.mockResolvedValue({ rows: [] });
    expect((await request(app).get(`${URL}/settings`).set('x-deny', 'data.write.contexts')).status).toBe(200);
  });

  it('404 while the feature is off', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get(`${URL}?type=Klant`)).status).toBe(404);
  });
});

describe('settings', () => {
  it('GET returns the stored map', async () => {
    query.mockResolvedValueOnce({ rows: [{ configValue: JSON.stringify({ Klant: { inactiveAfterMonths: 3 } }) }] });
    const r = await request(app).get(`${URL}/settings`);
    expect(r.body).toEqual({ Klant: { inactiveAfterMonths: 3, statusAttribute: null, inactiveValues: ['true'] } });
  });

  it('PUT merges and returns the stored map', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const r = await request(app).put(`${URL}/settings`).send({ Klant: { inactiveAfterMonths: 12, statusAttribute: 'archief' } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ Klant: { inactiveAfterMonths: 12, statusAttribute: 'archief', inactiveValues: ['true'] } });
    expect(query.mock.calls[1][1][0]).toBe(SIGNALS_KEY);
  });

  it('PUT 400 with the sentences, without writing', async () => {
    const r = await request(app).put(`${URL}/settings`).send({ Klant: { inactiveAfterMonths: 0 } });
    expect(r.status).toBe(400);
    expect(r.body.errors[0]).toMatch(/inactiveAfterMonths/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /signals', () => {
  it('400 without a type, or with one too long', async () => {
    expect((await request(app).get(URL)).status).toBe(400);
    expect((await request(app).get(`${URL}?type=%20`)).status).toBe(400);
    expect((await request(app).get(`${URL}?type=${'k'.repeat(201)}`)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers the findings for the type', async () => {
    query.mockResolvedValue({ rows: [] });
    const r = await request(app).get(`${URL}?type=Klant`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      type: 'Klant', settings: { inactiveAfterMonths: 6, statusAttribute: null, inactiveValues: ['true'] }, asOf: null,
      findings: { inactive: [], markedInactiveButActive: [], activeWithoutMembership: [], memberWithoutActivity: [] },
    });
  });

  it('500 with a generic message on a db error', async () => {
    query.mockRejectedValue(new Error('relation "OrgActivities" does not exist'));
    const r = await request(app).get(`${URL}?type=Klant`);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('Failed to compute the signals.');
  });
});

describe('GET /org-truth/activity/subject/:targetType/:id', () => {
  it('a collection entity without activity: 200 with empty totals', async () => {
    const r = await request(app).get(`/api/org-truth/activity/subject/OrgEntity/${ID}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ type: null, types: [], unit: null, total: 0, firstOn: null, lastOn: null, months: [], actors: [], unresolvedRows: 0 });
    expect(query.mock.calls[0][1]).toEqual(['OrgEntity', ID]);
  });

  it('passes ?type through', async () => {
    query.mockImplementation(async (raw) => (String(raw).includes('FROM "OrgActivities" a')
      ? { rows: [
        { activityType: 'Uren', actorId: null, rowCount: 5, total: 1, month: '2026-01', firstOn: '2026-01-01', lastOn: '2026-01-01' },
        { activityType: 'Calls', actorId: null, rowCount: 1, total: 2, month: '2026-01', firstOn: '2026-01-01', lastOn: '2026-01-01' },
      ] }
      : { rows: [] }));
    const r = await request(app).get(`/api/org-truth/activity/subject/Resource/${ID}?type=Calls`);
    expect(r.body).toMatchObject({ type: 'Calls', types: ['Uren', 'Calls'], total: 2 });
  });

  it('400 on another target type, a bad id or a bad type; no reads', async () => {
    expect((await request(app).get(`/api/org-truth/activity/subject/Principal/${ID}`)).status).toBe(400);
    expect((await request(app).get('/api/org-truth/activity/subject/OrgEntity/nope')).status).toBe(400);
    expect((await request(app).get(`/api/org-truth/activity/subject/OrgEntity/${ID}?type=${'t'.repeat(201)}`)).status).toBe(400);
    expect((await request(app).get(`/api/org-truth/activity/subject/OrgEntity/${ID}?type=a&type=b`)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('500 with a generic message on a db error; read gate first', async () => {
    query.mockRejectedValue(new Error('boom'));
    const r = await request(app).get(`/api/org-truth/activity/subject/OrgEntity/${ID}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('Failed to read the activity.');
    expect((await request(app).get(`/api/org-truth/activity/subject/OrgEntity/${ID}`).set('x-deny', 'data.read')).status).toBe(403);
  });
});

describe('GET /org-truth/activity/actor/:targetType/:id', () => {
  it('a principal: 200 with its groups', async () => {
    const r = await request(app).get(`/api/org-truth/activity/actor/Principal/${ID}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ groups: [] });
  });

  it('400 on a collection entity or a bad id', async () => {
    expect((await request(app).get(`/api/org-truth/activity/actor/OrgEntity/${ID}`)).status).toBe(400);
    expect((await request(app).get('/api/org-truth/activity/actor/Identity/x')).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('404 while the feature is off', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get(`/api/org-truth/activity/actor/Identity/${ID}`)).status).toBe(404);
  });
});

describe('GET /org-truth/enrichment/:targetType/:id', () => {
  it('returns the groups about the object', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })   // the identity's accounts
      .mockResolvedValueOnce({ rows: [{ entityId: 'm1', source: 'Maten', profileName: 'Maten', attributes: { expertises: ['IAM', 'Azure'] } }] });
    const r = await request(app).get(`/api/org-truth/enrichment/Identity/${ID}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ groups: [{ source: 'Maten', profileName: 'Maten', entityId: 'm1', attributes: { expertises: ['IAM', 'Azure'] } }] });
  });

  it('400 on another target type or a bad id, without reading', async () => {
    expect((await request(app).get(`/api/org-truth/enrichment/Context/${ID}`)).status).toBe(400);
    expect((await request(app).get('/api/org-truth/enrichment/Principal/x')).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('403 without data.read, 404 while the feature is off, 500 on a db error', async () => {
    expect((await request(app).get(`/api/org-truth/enrichment/Resource/${ID}`).set('x-deny', 'data.read')).status).toBe(403);
    query.mockRejectedValue(new Error('boom'));
    const r = await request(app).get(`/api/org-truth/enrichment/Resource/${ID}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('Failed to read the enrichments.');
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get(`/api/org-truth/enrichment/Resource/${ID}`)).status).toBe(404);
  });
});
