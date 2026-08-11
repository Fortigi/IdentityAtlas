// Coverage-focused unit tests for routes/riskProfiles.js. DB + LLM/scraper/
// vault/prompt modules all mocked (no network, no scraping, no vault, no real
// LLM call). Exercises the happy paths and error/502 branches that the existing
// riskProfiles.test.js (validation/404 only) does not reach.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));

const chatWithSavedConfig = vi.fn();
const isLLMConfigured = vi.fn();
const getLLMConfig = vi.fn();
vi.mock('../llm/service.js', () => ({
  chatWithSavedConfig: (...a) => chatWithSavedConfig(...a),
  isLLMConfigured: (...a) => isLLMConfigured(...a),
  getLLMConfig: (...a) => getLLMConfig(...a),
}));

const scrapeAll = vi.fn();
const buildLLMContextFromScrapes = vi.fn();
vi.mock('../llm/scraper.js', () => ({
  scrapeAll: (...a) => scrapeAll(...a),
  buildLLMContextFromScrapes: (...a) => buildLLMContextFromScrapes(...a),
}));

const profileGenerationPrompt = vi.fn();
const profileRefinementPrompt = vi.fn();
const classifierGenerationPrompt = vi.fn();
const extractJson = vi.fn();
vi.mock('../llm/riskPrompts.js', () => ({
  profileGenerationPrompt: (...a) => profileGenerationPrompt(...a),
  profileRefinementPrompt: (...a) => profileRefinementPrompt(...a),
  classifierGenerationPrompt: (...a) => classifierGenerationPrompt(...a),
  extractJson: (...a) => extractJson(...a),
}));

const putSecret = vi.fn();
const getSecret = vi.fn();
const deleteSecret = vi.fn();
vi.mock('../secrets/vault.js', () => ({
  putSecret: (...a) => putSecret(...a),
  getSecret: (...a) => getSecret(...a),
  deleteSecret: (...a) => deleteSecret(...a),
}));

const { default: router } = await import('./riskProfiles.js');
const app = mountRouter(router);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  chatWithSavedConfig.mockReset();
  isLLMConfigured.mockReset();
  getLLMConfig.mockReset();
  scrapeAll.mockReset();
  buildLLMContextFromScrapes.mockReset();
  profileGenerationPrompt.mockReset();
  profileRefinementPrompt.mockReset();
  classifierGenerationPrompt.mockReset();
  extractJson.mockReset();
  putSecret.mockReset();
  getSecret.mockReset();
  deleteSecret.mockReset();
});

// ─── /risk-profiles/scrape ─────────────────────────────────────────
describe('POST /risk-profiles/scrape', () => {
  it('200 — scrapes targets, resolves a credential, strips text by default', async () => {
    getSecret.mockResolvedValueOnce(JSON.stringify({ username: 'u', password: 'p' }));
    scrapeAll.mockResolvedValueOnce([{ url: 'https://a.com', ok: true, status: 200, bytes: 5, text: 'secret-text' }]);
    const res = await request(app).post('/api/risk-profiles/scrape').send({
      urls: [{ url: 'https://a.com', credentialId: 'cred1' }, { url: 'https://b.com', credentials: { bearer: 'tok' } }, { nope: true }],
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.results[0].text).toBeUndefined();
    expect(scrapeAll).toHaveBeenCalled();
  });

  it('200 — includeText=true keeps the scraped text', async () => {
    scrapeAll.mockResolvedValueOnce([{ url: 'https://a.com', ok: true, text: 'keep-me' }]);
    const res = await request(app).post('/api/risk-profiles/scrape?includeText=true').send({ urls: [{ url: 'https://a.com' }] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].text).toBe('keep-me');
  });

  it('200 — bearer-fallback when a stored secret is not JSON', async () => {
    getSecret.mockResolvedValueOnce('raw-bearer-token');
    scrapeAll.mockResolvedValueOnce([{ url: 'https://a.com', ok: true }]);
    const res = await request(app).post('/api/risk-profiles/scrape').send({ urls: [{ url: 'https://a.com', credentialId: 'c' }] });
    expect(res.status).toBe(200);
  });

  it('500 when scrapeAll rejects', async () => {
    scrapeAll.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/risk-profiles/scrape').send({ urls: [{ url: 'https://a.com' }] });
    expect(res.status).toBe(500);
  });
});

// ─── /risk-profiles/generate ───────────────────────────────────────
describe('POST /risk-profiles/generate', () => {
  it('412 when no LLM is configured', async () => {
    isLLMConfigured.mockResolvedValueOnce(false);
    const res = await request(app).post('/api/risk-profiles/generate').send({ domain: 'acme.com' });
    expect(res.status).toBe(412);
  });

  it('400 when domain is missing', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    const res = await request(app).post('/api/risk-profiles/generate').send({});
    expect(res.status).toBe(400);
  });

  it('200 — generates a profile (with a URL scrape phase)', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    getSecret.mockResolvedValueOnce(JSON.stringify({ bearer: 'b' }));
    scrapeAll.mockResolvedValueOnce([{ url: 'https://a.com', ok: true, status: 200, bytes: 9 }]);
    buildLLMContextFromScrapes.mockReturnValueOnce('ctx');
    profileGenerationPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockResolvedValueOnce({ text: '{"customer_profile":{"industry":"x"}}', model: 'gpt', usage: { outputTokens: 100 } });
    extractJson.mockReturnValueOnce({ customer_profile: { industry: 'x' } });
    const res = await request(app).post('/api/risk-profiles/generate').send({
      domain: 'acme.com', organizationName: 'Acme', hints: 'h', urls: [{ url: 'https://a.com', credentialId: 'c' }, { bad: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ industry: 'x' });
    expect(res.body.llmModel).toBe('gpt');
  });

  it('502 — truncated (non-JSON) LLM response with token cap hit', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    profileGenerationPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockResolvedValueOnce({ text: 'partial response with no closing brace at the end here', model: 'm', usage: { outputTokens: 8000 } });
    extractJson.mockReturnValueOnce(null);
    const res = await request(app).post('/api/risk-profiles/generate').send({ domain: 'acme.com' });
    expect(res.status).toBe(502);
    expect(res.body.truncated).toBe(true);
  });

  it('502 — malformed (non-truncated) LLM response', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    profileGenerationPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockResolvedValueOnce({ text: '}', model: 'm', usage: { outputTokens: 5 } });
    extractJson.mockReturnValueOnce(null);
    const res = await request(app).post('/api/risk-profiles/generate').send({ domain: 'acme.com' });
    expect(res.status).toBe(502);
    expect(res.body.truncated).toBe(false);
  });

  it('500 when chatWithSavedConfig rejects', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    profileGenerationPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockRejectedValueOnce(new Error('llm down'));
    const res = await request(app).post('/api/risk-profiles/generate').send({ domain: 'acme.com' });
    expect(res.status).toBe(500);
  });
});

// ─── /risk-profiles/refine ─────────────────────────────────────────
describe('POST /risk-profiles/refine', () => {
  it('412 when no LLM is configured', async () => {
    isLLMConfigured.mockResolvedValueOnce(false);
    const res = await request(app).post('/api/risk-profiles/refine').send({ profile: {}, userMessage: 'hi' });
    expect(res.status).toBe(412);
  });

  it('400 when profile is missing', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    const res = await request(app).post('/api/risk-profiles/refine').send({ userMessage: 'hi' });
    expect(res.status).toBe(400);
  });

  it('400 when userMessage is missing', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    const res = await request(app).post('/api/risk-profiles/refine').send({ profile: {} });
    expect(res.status).toBe(400);
  });

  it('200 — wrapped { assistantMessage, profile } response', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    profileRefinementPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockResolvedValueOnce({ text: 'x', model: 'm', usage: {} });
    extractJson.mockReturnValueOnce({ assistantMessage: 'done', profile: { customer_profile: { a: 1 } }, profileChanged: true });
    const res = await request(app).post('/api/risk-profiles/refine').send({ profile: { a: 0 }, userMessage: 'change it' });
    expect(res.status).toBe(200);
    expect(res.body.assistantMessage).toBe('done');
    expect(res.body.profileChanged).toBe(true);
    expect(res.body.profile).toMatchObject({ a: 1 });
  });

  it('200 — unwrapped (old-style) profile response', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    profileRefinementPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockResolvedValueOnce({ text: 'x', model: 'm', usage: {} });
    extractJson.mockReturnValueOnce({ industry: 'y' });
    const res = await request(app).post('/api/risk-profiles/refine').send({ profile: { a: 0 }, userMessage: 'go' });
    expect(res.status).toBe(200);
    expect(res.body.profileChanged).toBe(true);
    expect(res.body.assistantMessage).toBe('(profile updated)');
  });

  it('200 — unparseable JSON returns raw text, profile unchanged', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    profileRefinementPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockResolvedValueOnce({ text: '  just chatting  ', model: 'm', usage: {} });
    extractJson.mockReturnValueOnce(null);
    const res = await request(app).post('/api/risk-profiles/refine').send({ profile: { a: 9 }, userMessage: 'go' });
    expect(res.status).toBe(200);
    expect(res.body.profileChanged).toBe(false);
    expect(res.body.assistantMessage).toBe('just chatting');
    expect(res.body.profile).toMatchObject({ a: 9 });
  });

  it('500 when the LLM call rejects', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    profileRefinementPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockRejectedValueOnce(new Error('nope'));
    const res = await request(app).post('/api/risk-profiles/refine').send({ profile: {}, userMessage: 'go' });
    expect(res.status).toBe(500);
  });
});

// ─── POST /risk-profiles (save) ────────────────────────────────────
describe('POST /risk-profiles', () => {
  it('400 when profile is missing', async () => {
    const res = await request(app).post('/api/risk-profiles').send({ displayName: 'p' });
    expect(res.status).toBe(400);
  });

  it('201 — saves a new version row, makeActive', async () => {
    getLLMConfig.mockResolvedValueOnce({ provider: 'openai', model: 'gpt' });
    queryOne.mockResolvedValueOnce({ v: 3 });          // version
    queryOne.mockResolvedValueOnce({ id: 7, version: 3, createdAt: 'now' }); // insert
    const res = await request(app).post('/api/risk-profiles').send({
      displayName: 'p', profile: { domain: 'd', industry: 'i', country: 'c' }, transcript: [{ r: 1 }], sources: ['s'], makeActive: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 7, version: 3, isActive: true });
  });

  it('500 when the insert rejects', async () => {
    getLLMConfig.mockResolvedValueOnce(null);
    queryOne.mockResolvedValueOnce({ v: 1 });
    queryOne.mockRejectedValueOnce(new Error('insert failed'));
    const res = await request(app).post('/api/risk-profiles').send({ displayName: 'p', profile: {} });
    expect(res.status).toBe(500);
  });
});

// ─── GET /risk-profiles (list) ─────────────────────────────────────
describe('GET /risk-profiles', () => {
  it('200 — lists profiles', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    const res = await request(app).get('/api/risk-profiles');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('500 when the list query rejects', async () => {
    query.mockRejectedValueOnce(new Error('list failed'));
    const res = await request(app).get('/api/risk-profiles');
    expect(res.status).toBe(500);
  });
});

// ─── scraper-credentials CRUD ──────────────────────────────────────
describe('scraper-credentials', () => {
  it('GET 200 — lists scraper secrets', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'scraper.x', label: 'L' }] });
    const res = await request(app).get('/api/risk-profiles/scraper-credentials');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET 500 when the query rejects', async () => {
    query.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).get('/api/risk-profiles/scraper-credentials');
    expect(res.status).toBe(500);
  });

  it('POST 400 when label is missing', async () => {
    const res = await request(app).post('/api/risk-profiles/scraper-credentials').send({ username: 'u' });
    expect(res.status).toBe(400);
  });

  it('POST 400 when neither username nor bearer supplied', async () => {
    const res = await request(app).post('/api/risk-profiles/scraper-credentials').send({ label: 'L' });
    expect(res.status).toBe(400);
  });

  it('POST 201 — creates a username/password credential', async () => {
    putSecret.mockResolvedValueOnce();
    const res = await request(app).post('/api/risk-profiles/scraper-credentials').send({ label: 'L', username: 'u', password: 'p' });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('L');
    expect(putSecret).toHaveBeenCalled();
  });

  it('POST 201 — creates a bearer credential', async () => {
    putSecret.mockResolvedValueOnce();
    const res = await request(app).post('/api/risk-profiles/scraper-credentials').send({ label: 'L', bearer: 'tok' });
    expect(res.status).toBe(201);
  });

  it('POST 500 when putSecret rejects', async () => {
    putSecret.mockRejectedValueOnce(new Error('vault down'));
    const res = await request(app).post('/api/risk-profiles/scraper-credentials').send({ label: 'L', username: 'u' });
    expect(res.status).toBe(500);
  });

  it('DELETE 200 — removes a credential', async () => {
    deleteSecret.mockResolvedValueOnce();
    const res = await request(app).delete('/api/risk-profiles/scraper-credentials/scraper.x');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DELETE 500 when deleteSecret rejects', async () => {
    deleteSecret.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).delete('/api/risk-profiles/scraper-credentials/scraper.x');
    expect(res.status).toBe(500);
  });
});

// ─── GET /risk-profiles/:id ────────────────────────────────────────
describe('GET /risk-profiles/:id', () => {
  it('200 — returns the full profile body', async () => {
    queryOne.mockResolvedValueOnce({ id: 5, profile: {} });
    const res = await request(app).get('/api/risk-profiles/5');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
  });

  it('500 when the get query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).get('/api/risk-profiles/5');
    expect(res.status).toBe(500);
  });
});

// ─── POST /risk-profiles/:id/activate ──────────────────────────────
describe('POST /risk-profiles/:id/activate', () => {
  it('400 on a non-integer id', async () => {
    expect((await request(app).post('/api/risk-profiles/abc/activate')).status).toBe(400);
  });
  it('404 when the profile does not exist', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await request(app).post('/api/risk-profiles/5/activate')).status).toBe(404);
  });
  it('200 — activates the profile', async () => {
    queryOne.mockResolvedValueOnce({ id: 5 });
    const res = await request(app).post('/api/risk-profiles/5/activate');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
  it('500 when the update rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('x'));
    expect((await request(app).post('/api/risk-profiles/5/activate')).status).toBe(500);
  });
});

// ─── DELETE /risk-profiles/:id ─────────────────────────────────────
describe('DELETE /risk-profiles/:id', () => {
  it('400 on a non-integer id', async () => {
    expect((await request(app).delete('/api/risk-profiles/abc')).status).toBe(400);
  });
  it('200 — deletes the profile', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).delete('/api/risk-profiles/5');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
  it('500 when the delete rejects', async () => {
    query.mockRejectedValueOnce(new Error('x'));
    expect((await request(app).delete('/api/risk-profiles/5')).status).toBe(500);
  });
});

// ─── POST /risk-classifiers/generate ───────────────────────────────
describe('POST /risk-classifiers/generate', () => {
  it('412 when no LLM is configured', async () => {
    isLLMConfigured.mockResolvedValueOnce(false);
    const res = await request(app).post('/api/risk-classifiers/generate').send({ profileId: 1 });
    expect(res.status).toBe(412);
  });
  it('400 when profileId is missing', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    const res = await request(app).post('/api/risk-classifiers/generate').send({});
    expect(res.status).toBe(400);
  });
  it('404 when the profile does not exist', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).post('/api/risk-classifiers/generate').send({ profileId: 9 });
    expect(res.status).toBe(404);
  });
  it('200 — generates a classifier set', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    queryOne.mockResolvedValueOnce({ id: 9, profile: {} });
    classifierGenerationPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockResolvedValueOnce({ text: '{}', model: 'm', usage: {} });
    extractJson.mockReturnValueOnce({ groups: [] });
    const res = await request(app).post('/api/risk-classifiers/generate').send({ profileId: 9 });
    expect(res.status).toBe(200);
    expect(res.body.classifiers).toEqual({ groups: [] });
  });
  it('502 — non-JSON (truncated) classifier response', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    queryOne.mockResolvedValueOnce({ id: 9, profile: {} });
    classifierGenerationPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockResolvedValueOnce({ text: 'long truncated text without a closing brace at end', model: 'm', usage: { outputTokens: 9000 } });
    extractJson.mockReturnValueOnce(null);
    const res = await request(app).post('/api/risk-classifiers/generate').send({ profileId: 9 });
    expect(res.status).toBe(502);
    expect(res.body.truncated).toBe(true);
  });
  it('500 when the LLM call rejects', async () => {
    isLLMConfigured.mockResolvedValueOnce(true);
    queryOne.mockResolvedValueOnce({ id: 9, profile: {} });
    classifierGenerationPrompt.mockReturnValueOnce({ system: 's', messages: [] });
    chatWithSavedConfig.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).post('/api/risk-classifiers/generate').send({ profileId: 9 });
    expect(res.status).toBe(500);
  });
});

// ─── POST /risk-classifiers (save) ─────────────────────────────────
describe('POST /risk-classifiers', () => {
  it('400 when displayName is missing', async () => {
    const res = await request(app).post('/api/risk-classifiers').send({ classifiers: {} });
    expect(res.status).toBe(400);
  });
  it('400 when classifiers is missing', async () => {
    const res = await request(app).post('/api/risk-classifiers').send({ displayName: 'c' });
    expect(res.status).toBe(400);
  });
  it('201 — saves a classifier set', async () => {
    getLLMConfig.mockResolvedValueOnce({ provider: 'p', model: 'm' });
    queryOne.mockResolvedValueOnce({ v: 2 });
    queryOne.mockResolvedValueOnce({ id: 3, version: 2, createdAt: 'now' });
    const res = await request(app).post('/api/risk-classifiers').send({ displayName: 'c', profileId: 1, classifiers: { g: [] }, makeActive: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 3, version: 2 });
  });
  it('500 when the insert rejects', async () => {
    getLLMConfig.mockResolvedValueOnce(null);
    queryOne.mockResolvedValueOnce({ v: 1 });
    queryOne.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).post('/api/risk-classifiers').send({ displayName: 'c', classifiers: {} });
    expect(res.status).toBe(500);
  });
});

// ─── GET /risk-classifiers (list) + /:id + activate + delete ───────
describe('risk-classifiers read/activate/delete', () => {
  it('GET list 200', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const res = await request(app).get('/api/risk-classifiers');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
  it('GET list 500 on reject', async () => {
    query.mockRejectedValueOnce(new Error('x'));
    expect((await request(app).get('/api/risk-classifiers')).status).toBe(500);
  });
  it('GET /:id 400 on a non-integer id', async () => {
    expect((await request(app).get('/api/risk-classifiers/abc')).status).toBe(400);
  });
  it('GET /:id 404 when missing', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/risk-classifiers/5')).status).toBe(404);
  });
  it('GET /:id 200', async () => {
    queryOne.mockResolvedValueOnce({ id: 5 });
    expect((await request(app).get('/api/risk-classifiers/5')).status).toBe(200);
  });
  it('GET /:id 500 on reject', async () => {
    queryOne.mockRejectedValueOnce(new Error('x'));
    expect((await request(app).get('/api/risk-classifiers/5')).status).toBe(500);
  });
  it('activate 400 on a non-integer id', async () => {
    expect((await request(app).post('/api/risk-classifiers/abc/activate')).status).toBe(400);
  });
  it('activate 404 when missing', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await request(app).post('/api/risk-classifiers/5/activate')).status).toBe(404);
  });
  it('activate 200', async () => {
    queryOne.mockResolvedValueOnce({ id: 5 });
    expect((await request(app).post('/api/risk-classifiers/5/activate')).status).toBe(200);
  });
  it('activate 500 on reject', async () => {
    queryOne.mockRejectedValueOnce(new Error('x'));
    expect((await request(app).post('/api/risk-classifiers/5/activate')).status).toBe(500);
  });
  it('delete 400 on a non-integer id', async () => {
    expect((await request(app).delete('/api/risk-classifiers/abc')).status).toBe(400);
  });
  it('delete 200', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await request(app).delete('/api/risk-classifiers/5')).status).toBe(200);
  });
  it('delete 500 on reject', async () => {
    query.mockRejectedValueOnce(new Error('x'));
    expect((await request(app).delete('/api/risk-classifiers/5')).status).toBe(500);
  });
});
