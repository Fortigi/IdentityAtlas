// Unit tests for routes/riskProfiles.js — body validation + 404. DB + LLM/vault
// service modules mocked (no network, no scraping, no vault).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('../llm/service.js', () => ({ chatWithSavedConfig: vi.fn(), isLLMConfigured: vi.fn(), getLLMConfig: vi.fn() }));
vi.mock('../llm/scraper.js', () => ({ scrapeAll: vi.fn(), buildLLMContextFromScrapes: vi.fn() }));
vi.mock('../llm/riskPrompts.js', () => ({
  profileGenerationPrompt: vi.fn(), profileRefinementPrompt: vi.fn(),
  classifierGenerationPrompt: vi.fn(), extractJson: vi.fn(),
}));
vi.mock('../secrets/vault.js', () => ({ putSecret: vi.fn(), getSecret: vi.fn(), deleteSecret: vi.fn() }));

// Risk scoring is an experimental flag (off on a fresh install); these tests
// exercise the feature itself, so it starts on. Its OFF behaviour is asserted below.
const flags = vi.hoisted(() => ({ riskScoring: true }));
vi.mock('../featureFlags.js', async (orig) =>
  (await import('../../test-utils/featureFlagMock.js')).steeredFeatureFlags(await orig(), flags));

const { default: router } = await import('./riskProfiles.js');
const app = mountRouter(router);
const service = await import('../llm/service.js');
const scraper = await import('../llm/scraper.js');

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('POST /risk-profiles/scrape — validation', () => {
  it('400 when urls is missing or empty', async () => {
    expect((await request(app).post('/api/risk-profiles/scrape').send({})).status).toBe(400);
    expect((await request(app).post('/api/risk-profiles/scrape').send({ urls: [] })).status).toBe(400);
  });
  it('400 when more than 20 urls are supplied', async () => {
    const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    expect((await request(app).post('/api/risk-profiles/scrape').send({ urls })).status).toBe(400);
  });
});

describe('POST /risk-profiles — validation', () => {
  it('400 when displayName is missing', async () => {
    const res = await request(app).post('/api/risk-profiles').send({ profile: {} });
    expect(res.status).toBe(400);
  });
});

describe('POST /risk-classifiers — pattern validation (M-6)', () => {
  it('400 with the offending list when a classifier pattern is invalid/unsupported', async () => {
    const res = await request(app).post('/api/risk-classifiers').send({
      displayName: 'set1',
      classifiers: { groupClassifiers: [{ id: 'g1', patterns: ['(?=lookahead)admin'] }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.invalidPatterns).toHaveLength(1);
    expect(res.body.invalidPatterns[0].pattern).toBe('(?=lookahead)admin');
  });
  it('does not reject valid patterns at the validation step', async () => {
    const res = await request(app).post('/api/risk-classifiers').send({
      displayName: 'set1',
      classifiers: { groupClassifiers: [{ id: 'g1', patterns: ['\\bdomain admin\\b'] }] },
    });
    expect(res.body.invalidPatterns).toBeUndefined();
  });
});

describe('GET /risk-profiles/:id — branching', () => {
  it('400 when the id is not an integer', async () => {
    const res = await request(app).get('/api/risk-profiles/abc');
    expect(res.status).toBe(400);
  });
  it('404 when the profile does not exist', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/risk-profiles/5');
    expect(res.status).toBe(404);
  });
});

// Risk scoring is experimental: while its flag is off, no profile or classifier
// endpoint exists — nothing is read, written, scraped or sent to the model.
describe('with the riskScoring flag off', () => {
  const ID = '11111111-1111-1111-1111-111111111111';
  afterEach(() => { flags.riskScoring = true; });
  const calls = [
    ['POST /risk-profiles/scrape', a => request(a).post('/api/risk-profiles/scrape').send({ urls: [{ url: 'https://example.com' }] })],
    ['POST /risk-profiles/generate', a => request(a).post('/api/risk-profiles/generate').send({ domain: 'example.com' })],
    ['POST /risk-profiles/refine', a => request(a).post('/api/risk-profiles/refine').send({ profile: {}, message: 'x' })],
    ['POST /risk-profiles', a => request(a).post('/api/risk-profiles').send({ displayName: 'x', profile: {} })],
    ['GET /risk-profiles', a => request(a).get('/api/risk-profiles')],
    ['GET /risk-profiles/scraper-credentials', a => request(a).get('/api/risk-profiles/scraper-credentials')],
    ['POST /risk-profiles/scraper-credentials', a => request(a).post('/api/risk-profiles/scraper-credentials').send({ name: 'x' })],
    ['DELETE /risk-profiles/scraper-credentials/:id', a => request(a).delete(`/api/risk-profiles/scraper-credentials/${ID}`)],
    ['GET /risk-profiles/:id', a => request(a).get(`/api/risk-profiles/${ID}`)],
    ['POST /risk-profiles/:id/activate', a => request(a).post(`/api/risk-profiles/${ID}/activate`)],
    ['DELETE /risk-profiles/:id', a => request(a).delete(`/api/risk-profiles/${ID}`)],
    ['POST /risk-classifiers/generate', a => request(a).post('/api/risk-classifiers/generate').send({ profileId: ID })],
    ['POST /risk-classifiers', a => request(a).post('/api/risk-classifiers').send({ displayName: 'x', classifiers: [] })],
    ['GET /risk-classifiers', a => request(a).get('/api/risk-classifiers')],
    ['GET /risk-classifiers/:id', a => request(a).get(`/api/risk-classifiers/${ID}`)],
    ['POST /risk-classifiers/:id/activate', a => request(a).post(`/api/risk-classifiers/${ID}/activate`)],
    ['DELETE /risk-classifiers/:id', a => request(a).delete(`/api/risk-classifiers/${ID}`)],
  ];

  it.each(calls)('%s answers 404 without touching the database, the model or the scraper', async (_name, call) => {
    vi.clearAllMocks();
    flags.riskScoring = false;
    const res = await call(app);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This feature is not enabled' });
    for (const fn of [query, queryOne, service.chatWithSavedConfig, service.isLLMConfigured, scraper.scrapeAll]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('the same list answers once the flag is on', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, displayName: 'Profile A' }] });
    const res = await request(app).get('/api/risk-profiles');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ id: ID, displayName: 'Profile A' })]);
  });

  it('gates only its own paths, not the rest of the shared /api mount', async () => {
    flags.riskScoring = false;
    const a = mountRouter(router);
    a.get('/api/risk-profile-other', (_req, res) => res.json({ ok: true }));
    expect((await request(a).get('/api/risk-profile-other')).status).toBe(200);
  });
});
