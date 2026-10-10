import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import router from './model.js';

const app = mountRouter(router);
const ID = 'e0000000-0000-4000-8000-000000000001';
const SRC = 'a0000000-0000-4000-8000-0000000000aa';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue(undefined); // feature flag: no override, env decides
  process.env.FEATURE_ORG_TRUTH = 'true';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the feature gate', () => {
  it('answers 404 on every route while the feature is off, without touching the org tables', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    for (const path of ['/api/org-truth/model', '/api/org-truth/entities', `/api/org-truth/entities/${ID}`, `/api/org-truth/entities/${ID}/graph`, '/api/org-truth/filter-options?type=Klant']) {
      expect((await request(app).get(path)).status, path).toBe(404);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /org-truth/model', () => {
  it('returns the meta-graph with the default options', async () => {
    query.mockResolvedValue({ rows: [] });
    const r = await request(app).get('/api/org-truth/model');
    expect(r.status).toBe(200);
    expect(r.body.totals).toEqual({ entities: 0, relations: 0, links: 0, sources: 0 });
    expect(r.body.systemTypes).toHaveLength(4);
    expect(r.body.entityLinks).toEqual([]);
    expect(r.body.profiles).toEqual([]);
    // types, keys, predicates, links, entity links, sources, system counts, profiles
    // + the template parts: templates, enrichments, activities, activity keys, pairs
    expect(query).toHaveBeenCalledTimes(13);
    expect(query.mock.calls[0][0]).toMatch(/"validTo" IS NULL/);
  });

  it('passes includeClosed, sourceId and withSystemCounts=0 through', async () => {
    query.mockResolvedValue({ rows: [] });
    const r = await request(app).get(`/api/org-truth/model?includeClosed=1&sourceId=${SRC}&withSystemCounts=0`);
    expect(r.status).toBe(200);
    expect(r.body.systemTypes).toEqual([]);
    expect(query).toHaveBeenCalledTimes(12);
    expect(query.mock.calls[0][0]).not.toMatch(/"validTo" IS NULL/);
    expect(query.mock.calls[0][1]).toEqual([SRC]);
  });

  it('also skips system counts for withSystemCounts=false', async () => {
    query.mockResolvedValue({ rows: [] });
    await request(app).get('/api/org-truth/model?withSystemCounts=false');
    expect(query).toHaveBeenCalledTimes(12);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM "Principals"'))).toBe(false);
  });

  it('400 for a malformed sourceId, 500 with a generic message on a db error', async () => {
    expect((await request(app).get('/api/org-truth/model?sourceId=nope')).status).toBe(400);
    query.mockRejectedValue(new Error('relation "OrgEntities" does not exist'));
    const r = await request(app).get('/api/org-truth/model');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to load the organisation model' });
  });
});

describe('GET /org-truth/entities', () => {
  it('returns a page with total, page and pageSize', async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 51 }] }).mockResolvedValueOnce({ rows: [{ id: ID, displayName: 'Apollo' }] });
    const r = await request(app).get('/api/org-truth/entities?page=2&pageSize=50&type=Project');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [{ id: ID, displayName: 'Apollo' }], total: 51, page: 2, pageSize: 50 });
    expect(query.mock.calls[1][1]).toEqual(['Project', 50, 50]);
  });

  it('escapes % and _ in q before binding it', async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    await request(app).get(`/api/org-truth/entities?q=${encodeURIComponent('100%_')}`);
    expect(query.mock.calls[0][1]).toEqual(['%100\\%\\_%']);
    expect(query.mock.calls[0][0]).toContain(`ESCAPE '\\'`);
  });

  it('400 on a bad parameter, 500 on a db error', async () => {
    const bad = await request(app).get('/api/org-truth/entities?status=maybe');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/status must be one of/);
    expect(query).not.toHaveBeenCalled();
    query.mockRejectedValue(new Error('boom'));
    const r = await request(app).get('/api/org-truth/entities');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to load organisation entities' });
  });
});

describe('GET /org-truth/entities/:id', () => {
  it('400 for a malformed id, 404 for an unknown one', async () => {
    expect((await request(app).get('/api/org-truth/entities/abc')).status).toBe(400);
    query.mockResolvedValueOnce({ rows: [] });
    const r = await request(app).get(`/api/org-truth/entities/${ID}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Entity not found' });
  });

  it('returns the entity with relations and links', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: ID, entityType: 'Project', displayName: 'Apollo', attributes: { budget: 1 }, runId: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await request(app).get(`/api/org-truth/entities/${ID}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID, displayName: 'Apollo', attributes: { budget: 1 }, run: null, relations: { out: [], in: [] }, links: [] });
  });

  it('500 on a db error', async () => {
    query.mockRejectedValue(new Error('boom'));
    const r = await request(app).get(`/api/org-truth/entities/${ID}`);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to load the organisation entity' });
  });
});

describe('GET /org-truth/entities/:id/graph', () => {
  const core = { id: ID, entityType: 'Project', displayName: 'Apollo' };

  it('returns core + categories without ?category', async () => {
    query
      .mockResolvedValueOnce({ rows: [core] })
      .mockResolvedValueOnce({ rows: [{ direction: 'out', predicate: 'owner', n: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await request(app).get(`/api/org-truth/entities/${ID}/graph`);
    expect(r.status).toBe(200);
    expect(r.body.core.counts.relationsOut).toBe(1);
    expect(r.body.categories).toEqual([{ key: 'rel:out:owner', label: 'owner →', count: 1, kind: 'category' }]);
  });

  it('returns the items of one category', async () => {
    query
      .mockResolvedValueOnce({ rows: [core] })
      .mockResolvedValueOnce({ rows: [{ id: 'x', displayName: 'Ada', entityType: 'Person', status: 'accepted' }] });
    const r = await request(app).get(`/api/org-truth/entities/${ID}/graph?category=${encodeURIComponent('rel:out:owner')}`);
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ entityKind: 'org-entity', entityId: 'x' });
    expect(query.mock.calls[1][1]).toEqual([ID, 'owner']);
  });

  it('400 for a malformed id or an unknown category, 404 for an unknown entity', async () => {
    expect((await request(app).get('/api/org-truth/entities/abc/graph')).status).toBe(400);
    const bad = await request(app).get(`/api/org-truth/entities/${ID}/graph?category=link:Systems`);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'Unknown category' });
    expect((await request(app).get(`/api/org-truth/entities/${ID}/graph?category=`)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    expect((await request(app).get(`/api/org-truth/entities/${ID}/graph`)).status).toBe(404);
    expect((await request(app).get(`/api/org-truth/entities/${ID}/graph?category=link:Resource`)).status).toBe(404);
  });

  it('500 on a db error', async () => {
    query.mockRejectedValue(new Error('boom'));
    const r = await request(app).get(`/api/org-truth/entities/${ID}/graph`);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to load the entity graph' });
  });
});

describe('GET /org-truth/entities/:id/evidence', () => {
  const entityOnly = (row) => queryOne.mockImplementation(async (sql) => (sql.includes('FROM "OrgEntities"') ? row : undefined));

  it('400 for a malformed id, without reading', async () => {
    const r = await request(app).get('/api/org-truth/entities/abc/evidence');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid entity id' });
    expect(query).not.toHaveBeenCalled();
  });

  it('404 for an unknown entity', async () => {
    entityOnly(null);
    const r = await request(app).get(`/api/org-truth/entities/${ID}/evidence`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Entity not found' });
  });

  it('200 with the evidence', async () => {
    entityOnly({ id: ID, entityType: 'Customer', displayName: 'Contoso' });
    query.mockResolvedValue({ rows: [] });
    const r = await request(app).get(`/api/org-truth/entities/${ID}/evidence`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ entity: { id: ID, entityType: 'Customer', displayName: 'Contoso' }, people: [], activity: null, workedNotListed: [] });
  });

  it('500 with a generic message on a db error', async () => {
    entityOnly({ id: ID, entityType: 'Customer', displayName: 'Contoso' });
    query.mockRejectedValue(new Error('boom'));
    const r = await request(app).get(`/api/org-truth/entities/${ID}/evidence`);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to load the entity evidence' });
  });

  it('is behind the feature gate', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get(`/api/org-truth/entities/${ID}/evidence`)).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /org-truth/filter-options', () => {
  it('answers the picker options for the type, bound as a parameter', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
      .mockResolvedValueOnce({ rows: [{ key: 'iso27001', value: 'Ja', n: 2, distinctCount: 1 }] })
      .mockResolvedValueOnce({ rows: [{ name: 'eigenaar', targetType: 'Principal', links: 2 }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await request(app).get(`/api/org-truth/filter-options?type=${encodeURIComponent("Klant's")}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      entityType: "Klant's", entityCount: 2,
      attributes: [{ key: 'iso27001', distinct: 1, free: false, values: [{ value: 'Ja', count: 2 }] }],
      vias: [{ name: 'eigenaar', kind: 'direct', targets: ['Principal'], links: 2 }],
    });
    expect(query.mock.calls.every(([sql, params]) => !sql.includes("Klant's") && params[0] === "Klant's")).toBe(true);
  });

  it.each([
    ['missing', ''],
    ['blank', '?type=%20%20'],
    ['repeated (an array)', '?type=a&type=b'],
    ['too long', `?type=${'k'.repeat(201)}`],
  ])('400 when type is %s, without querying', async (_label, qs) => {
    const r = await request(app).get(`/api/org-truth/filter-options${qs}`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'type is required' });
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts a type of exactly 200 characters', async () => {
    query.mockResolvedValue({ rows: [] });
    expect((await request(app).get(`/api/org-truth/filter-options?type=${'k'.repeat(200)}`)).status).toBe(200);
  });

  it('500 with a generic message on a db error', async () => {
    query.mockRejectedValue(new Error('relation "OrgLinks" does not exist'));
    const r = await request(app).get('/api/org-truth/filter-options?type=Klant');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to load the filter options' });
  });
});
