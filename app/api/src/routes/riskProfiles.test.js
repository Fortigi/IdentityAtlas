// Unit tests for routes/riskProfiles.js — body validation + 404. DB + LLM/vault
// service modules mocked (no network, no scraping, no vault).

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const { default: router } = await import('./riskProfiles.js');
const app = mountRouter(router);

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
