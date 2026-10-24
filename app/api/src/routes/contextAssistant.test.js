import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

vi.mock('../db/connection.js');
vi.mock('../contextAssistant/service.js', () => ({
  interpret: vi.fn(),
  suggestMore: vi.fn(),
  ensureWarm: vi.fn(() => ({ state: 'ready', promise: Promise.resolve({ model: 'm', ms: 5, restored: true }) })),
  warmupState: vi.fn(() => 'ready'),
}));
vi.mock('../nlreports/llm.js', () => ({
  listModels: vi.fn(async () => [{ name: 'test-model', loaded: true }]),
  modelState: vi.fn(async () => 'ready'),
}));
vi.mock('../nlreports/settings.js', () => ({ getReportModel: vi.fn(async () => 'test-model') }));
vi.mock('../nlreports/service.js', () => ({ loadValues: vi.fn(async () => ({ resourceType: ['Group', 'AppRole'] })) }));
vi.mock('../nlreports/references.js', () => ({
  searchNames: vi.fn(async () => [{ id: 'r1', name: 'Inkoop', type: 'Group' }]),
  // nlreports/terms.js builds its vocabulary from this at import time.
  normalizeName: (s) => String(s).toLowerCase(),
}));
vi.mock('../contexts/recipe/matches.js', () => ({
  loadCandidates: vi.fn(async () => ({ rows: [], scopeTotal: 158, truncated: false })),
  computeMatches: vi.fn(() => ({ terms: [{ key: 'inkoop', hits: 3 }], matches: [{ id: 'g1', status: 'member' }], memberIds: ['g1'], addedByModel: 0 })),
}));
vi.mock('../contexts/recipe/relatedWords.js', () => ({
  loadScopeNames: vi.fn(async () => [{ id: 'g1', displayName: 'Inkoop' }]),
  relatedWords: vi.fn(() => [{ word: 'vsts', inContext: 2, outside: 0, lift: 3 }]),
}));
vi.mock('../contexts/plugins/runner.js', () => ({ enqueueRun: vi.fn(async () => 'run-1'), getRun: vi.fn(async () => ({ status: 'succeeded', membersAdded: 4, membersRemoved: 1 })) }));

import { queryOne } from '../db/connection.js';
import { interpret, suggestMore } from '../contextAssistant/service.js';
import { computeMatches, loadCandidates } from '../contexts/recipe/matches.js';
import { relatedWords } from '../contexts/recipe/relatedWords.js';
import { enqueueRun, getRun } from '../contexts/plugins/runner.js';
import router from './contextAssistant.js';

const app = mountRouter(router);
const api = () => request(app);
const CONTEXT_ID = '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab';
const RECIPE = { name: 'Inkoop', terms: ['inkoop'] };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEATURE_CONTEXT_ASSISTANT = 'true';
  interpret.mockResolvedValue({ kind: 'terms', name: 'Inkoop', terms: [], notes: [] });
  suggestMore.mockResolvedValue({ kind: 'terms', name: 'Inkoop', terms: [], notes: [] });
  getRun.mockResolvedValue({ status: 'succeeded', membersAdded: 4, membersRemoved: 1 });
});

describe('the experimental feature gate', () => {
  it('answers 404 on every route while the context assistant is switched off', async () => {
    process.env.FEATURE_CONTEXT_ASSISTANT = 'false';
    // Every route the router declares, read from the router itself — a route added later
    // without the gate fails here instead of shipping open.
    const routes = router.stack.filter(l => l.route).flatMap(l =>
      Object.keys(l.route.methods).map(method => [method, `/api${l.route.path.replace(':id', CONTEXT_ID)}`]));
    expect(routes.length).toBeGreaterThanOrEqual(9);
    for (const [method, path] of routes) {
      const res = await api()[method](path).send({ recipe: RECIPE, question: 'x' });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(interpret).not.toHaveBeenCalled();
    expect(enqueueRun).not.toHaveBeenCalled();
  });
});

describe('GET /context-assistant/options', () => {
  it('offers the resource types that exist and the fields a recipe may search', async () => {
    const res = await api().get('/api/context-assistant/options');
    expect(res.status).toBe(200);
    expect(res.body.resourceTypes).toEqual(['Group', 'AppRole']);
    expect(res.body.fields).toEqual([
      { name: 'displayName', label: 'Name' },
      { name: 'description', label: 'Description' },
      { name: 'mail', label: 'Mail address' },
    ]);
  });
});

describe('POST /context-assistant/interpret', () => {
  it('passes the trimmed question on and answers with what the model proposed', async () => {
    const res = await api().post('/api/context-assistant/interpret').send({ question: '  inkoopgroepen  ' });
    expect(res.status).toBe(200);
    expect(interpret).toHaveBeenCalledWith({ question: 'inkoopgroepen', history: [] });
    expect(res.body.kind).toBe('terms');
  });

  it('refuses an empty question without asking the model', async () => {
    const res = await api().post('/api/context-assistant/interpret').send({ question: '   ' });
    expect(res.status).toBe(400);
    expect(interpret).not.toHaveBeenCalled();
  });

  it('answers 502 when the model server fails, without leaking the reason', async () => {
    interpret.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:8080'));
    const res = await api().post('/api/context-assistant/interpret').send({ question: 'inkoop' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });
});

describe('POST /context-assistant/suggest', () => {
  it('needs both the description and a recipe', async () => {
    expect((await api().post('/api/context-assistant/suggest').send({ recipe: RECIPE })).status).toBe(400);
    expect((await api().post('/api/context-assistant/suggest').send({ question: 'inkoop' })).status).toBe(400);
    expect(suggestMore).not.toHaveBeenCalled();
  });

  it('sends the validated recipe, not the raw body', async () => {
    await api().post('/api/context-assistant/suggest').send({ question: 'inkoop', recipe: { terms: ['inkoop'], structure: 'nested' } });
    expect(suggestMore.mock.calls[0][0].recipe).toMatchObject({ structure: 'byTerm', version: 1 });
  });
});

describe('POST /context-assistant/evaluate', () => {
  it('answers with the normalised recipe and what it finds', async () => {
    const res = await api().post('/api/context-assistant/evaluate').send({ recipe: RECIPE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scopeTotal: 158, truncated: false, memberCount: 1, addedByModel: 0 });
    expect(res.body.recipe.terms[0]).toMatchObject({ text: 'inkoop', match: 'wordStart' });
    expect(loadCandidates).toHaveBeenCalled();
  });

  it('hands back the errors of a recipe that cannot run, rather than failing', async () => {
    computeMatches.mockReturnValueOnce({ terms: [], matches: [], memberIds: [], addedByModel: 0 });
    const res = await api().post('/api/context-assistant/evaluate').send({ recipe: { terms: ['x'] } });
    expect(res.status).toBe(200);
    expect(res.body.errors).toContain('"x" is too short to search for.');
  });

  it('refuses a body without a recipe', async () => {
    expect((await api().post('/api/context-assistant/evaluate').send({})).status).toBe(400);
  });
});

describe('POST /context-assistant/related', () => {
  it('ranks words from the data for the objects the recipe finds', async () => {
    const res = await api().post('/api/context-assistant/related').send({ recipe: RECIPE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ word: 'vsts', inContext: 2, outside: 0, lift: 3 }], contextSize: 1 });
    expect(relatedWords).toHaveBeenCalled();
  });
});

describe('GET /context-assistant/lookup', () => {
  it('searches names, and stays quiet for a query too short to mean anything', async () => {
    const res = await api().get('/api/context-assistant/lookup?q=ink');
    expect(res.body.data).toEqual([{ id: 'r1', name: 'Inkoop', type: 'Group' }]);
    expect((await api().get('/api/context-assistant/lookup?q=i')).body).toEqual({ data: [] });
  });
});

describe('GET /context-assistant/recipe/:id', () => {
  it('answers with the stored recipe and the description it was built from', async () => {
    queryOne.mockResolvedValueOnce({ id: CONTEXT_ID, sourceInstanceKey: 'key-1', parameters: { recipe: RECIPE, question: 'inkoopgroepen' } });
    const res = await api().get(`/api/context-assistant/recipe/${CONTEXT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contextId: CONTEXT_ID, question: 'inkoopgroepen' });
    expect(res.body.recipe.terms[0].text).toBe('inkoop');
  });

  it('is 404 for a context built by something else, and for a non-id', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await api().get(`/api/context-assistant/recipe/${CONTEXT_ID}`)).status).toBe(404);
    expect((await api().get('/api/context-assistant/recipe/not-a-uuid')).status).toBe(404);
  });
});

describe('POST /context-assistant/save', () => {
  it('creates a tree: runs the plugin now and answers with the context to open', async () => {
    queryOne.mockResolvedValueOnce({ id: 'ctx-new' });   // the root the run produced
    const res = await api().post('/api/context-assistant/save').send({ recipe: RECIPE, question: 'inkoopgroepen' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ runId: 'run-1', contextId: 'ctx-new', membersAdded: 4, membersRemoved: 1 });
    const [plugin, params, , opts] = enqueueRun.mock.calls[0];
    expect(plugin).toBe('context-recipe');
    expect(params.recipe).toMatchObject({ name: 'Inkoop', version: 1 });
    expect(params.question).toBe('inkoopgroepen');
    expect(params.instanceKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(opts).toEqual({ awaitCompletion: true });
  });

  it('refreshes an existing tree in place, on its own instance key', async () => {
    queryOne
      .mockResolvedValueOnce({ id: CONTEXT_ID, sourceInstanceKey: 'key-1', parameters: {} })  // the tree being edited
      .mockResolvedValueOnce({ id: CONTEXT_ID });
    const res = await api().post('/api/context-assistant/save').send({ recipe: RECIPE, contextId: CONTEXT_ID });
    expect(res.status).toBe(200);
    expect(enqueueRun.mock.calls[0][1].instanceKey).toBe('key-1');
  });

  it('refuses to save a context without a name, or one nothing can match', async () => {
    const nameless = await api().post('/api/context-assistant/save').send({ recipe: { terms: ['inkoop'] } });
    expect(nameless.status).toBe(400);
    expect(nameless.body.errors).toContain('Give the context a name.');
    const empty = await api().post('/api/context-assistant/save').send({ recipe: { name: 'X', terms: [] } });
    expect(empty.status).toBe(400);
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it('is 404 when the context to refresh was not built by the assistant', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect((await api().post('/api/context-assistant/save').send({ recipe: RECIPE, contextId: CONTEXT_ID })).status).toBe(404);
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it('reports a failed run with what the runner recorded', async () => {
    getRun.mockResolvedValueOnce({ status: 'failed', errorMessage: 'statement timeout' });
    const res = await api().post('/api/context-assistant/save').send({ recipe: RECIPE });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ detail: 'statement timeout', runId: 'run-1' });
  });
});
