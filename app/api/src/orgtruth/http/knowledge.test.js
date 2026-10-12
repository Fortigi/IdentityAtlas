import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../db/connection.js');
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));
vi.mock('../../config/authConfig.js', () => ({ isAuthEnabled: () => true }));
vi.mock('../knowledge/model.js', () => ({ modelStatus: vi.fn() }));
vi.mock('../knowledge/run.js', () => ({ startExtraction: vi.fn() }));
vi.mock('../knowledge/store.js', () => ({
  findTranscriptBySha: vi.fn(), insertTranscript: vi.fn(), listTranscripts: vi.fn(), getTranscript: vi.fn(), getPassages: vi.fn(async () => []),
  createExtractRun: vi.fn(), findActiveExtraction: vi.fn(), getRun: vi.fn(), requestCancel: vi.fn(),
}));
vi.mock('../knowledge/read.js', () => ({ listRuns: vi.fn(async () => []) }));

import { mountRouterAs } from '../../../test-utils/routeTestKit.js';
import router from './knowledge.js';
import { modelStatus } from '../knowledge/model.js';
import { startExtraction } from '../knowledge/run.js';
import {
  findTranscriptBySha, insertTranscript, listTranscripts, getTranscript, createExtractRun, findActiveExtraction, getRun, requestCancel,
} from '../knowledge/store.js';

const SRC = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const app = mountRouterAs(router, (req) => ({ preferred_username: req.headers['x-user'] ?? 'wim@fortigi', permissions: new Set(req.headers['x-admin'] ? ['*'] : ['data.read']) }));

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  process.env.FEATURE_KNOWLEDGE_EXTRACTION = 'true';
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  modelStatus.mockResolvedValue({ configured: true, reachable: true, model: 'qwen' });
  findActiveExtraction.mockResolvedValue(null);
});

describe('gates', () => {
  it.each([
    ['get', '/api/org-truth/knowledge/status', 'data.read'],
    ['get', '/api/org-truth/knowledge/sources', 'data.read'],
    ['post', '/api/org-truth/knowledge/sources', 'data.write.contexts'],
    ['post', `/api/org-truth/knowledge/sources/${SRC}/extract`, 'data.write.contexts'],
    ['get', `/api/org-truth/knowledge/runs/${RUN}/diagnostics`, 'data.write.contexts'],
    ['post', `/api/org-truth/knowledge/runs/${RUN}/cancel`, 'data.write.contexts'],
  ])('%s %s needs %s', async (method, path, perm) => {
    const res = await request(app)[method](path).set('x-deny', perm);
    expect(res.status).toBe(403);
  });

  it('answers 404 while either flag is off', async () => {
    process.env.FEATURE_KNOWLEDGE_EXTRACTION = 'false';
    expect((await request(app).get('/api/org-truth/knowledge/sources')).status).toBe(404);
    process.env.FEATURE_KNOWLEDGE_EXTRACTION = 'true';
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get('/api/org-truth/knowledge/sources')).status).toBe(404);
  });
});

describe('POST /knowledge/sources', () => {
  it('stores pasted text with its passages and the uploader', async () => {
    findTranscriptBySha.mockResolvedValue(null);
    insertTranscript.mockImplementation(async (_client, f) => ({ id: SRC, displayName: f.displayName }));
    const res = await request(app).post('/api/org-truth/knowledge/sources')
      .send({ text: 'Wim: Het bestuur is Wim, Gregor en Eddie.\n\nRob: Ik zit in het kernteam.', displayName: 'Interview Wim', speaker: 'Wim', language: 'nl' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: SRC, displayName: 'Interview Wim', duplicate: false });
    const f = insertTranscript.mock.calls[0][1];
    expect(f.uploadedBy).toBe('wim@fortigi');
    expect(f.passages.map(p => p.speaker)).toEqual(['Wim', 'Rob']);
    expect(f.metadata).toMatchObject({ language: 'nl', speaker: 'Wim', classification: 'internal', passageCount: 2 });
  });

  it('the same text again is the same source (200, duplicate) and is not stored twice', async () => {
    findTranscriptBySha.mockResolvedValue({ id: SRC, displayName: 'eerder' });
    const res = await request(app).post('/api/org-truth/knowledge/sources').send({ text: 'Iets.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: SRC, duplicate: true });
    expect(insertTranscript).not.toHaveBeenCalled();
  });

  it('accepts an .srt upload and refuses other files and empty requests', async () => {
    findTranscriptBySha.mockResolvedValue(null);
    insertTranscript.mockResolvedValue({ id: SRC });
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nWim is maat.\n';
    expect((await request(app).post('/api/org-truth/knowledge/sources').attach('file', Buffer.from(srt), 'wim.srt')).status).toBe(201);
    expect(insertTranscript.mock.calls[0][1].metadata.format).toBe('srt');
    expect((await request(app).post('/api/org-truth/knowledge/sources').attach('file', Buffer.from('x'), 'list.xlsx')).status).toBe(400);
    expect((await request(app).post('/api/org-truth/knowledge/sources').send({})).status).toBe(400);
  });
});

describe('visibility of restricted transcripts', () => {
  const restricted = { id: SRC, displayName: 'Geheim', uploadedBy: 'gregor@fortigi', metadata: { classification: 'restricted' } };

  it('hidden from others, visible to the uploader and to administrators', async () => {
    listTranscripts.mockResolvedValue([restricted, { id: 'b', metadata: { classification: 'internal' } }]);
    expect((await request(app).get('/api/org-truth/knowledge/sources')).body.map(s => s.id)).toEqual(['b']);
    expect((await request(app).get('/api/org-truth/knowledge/sources').set('x-user', 'gregor@fortigi')).body).toHaveLength(2);
    expect((await request(app).get('/api/org-truth/knowledge/sources').set('x-admin', '1')).body).toHaveLength(2);
    getTranscript.mockResolvedValue(restricted);
    expect((await request(app).get(`/api/org-truth/knowledge/sources/${SRC}`)).status).toBe(404);
    expect((await request(app).get(`/api/org-truth/knowledge/sources/${SRC}`).set('x-user', 'gregor@fortigi')).status).toBe(200);
  });
});

describe('POST /knowledge/sources/:id/extract', () => {
  beforeEach(() => getTranscript.mockResolvedValue({ id: SRC, metadata: {} }));

  it('queues a run and starts it in the background (202)', async () => {
    createExtractRun.mockResolvedValue({ id: RUN, status: 'queued', details: { cache: { a: 1 }, config: {} } });
    const res = await request(app).post(`/api/org-truth/knowledge/sources/${SRC}/extract`).send({ mode: 'single' });
    expect(res.status).toBe(202);
    expect(res.body.details.cache).toBeUndefined();
    expect(res.body.cachedCalls).toBe(1);
    expect(createExtractRun).toHaveBeenCalledWith({ sourceId: SRC, triggeredBy: 'wim@fortigi', config: { mode: 'single', resume: true } });
    expect(startExtraction).toHaveBeenCalledWith(RUN);
  });

  it('409 without a reachable model — and never a cloud fallback', async () => {
    modelStatus.mockResolvedValue({ configured: false, reachable: false });
    const res = await request(app).post(`/api/org-truth/knowledge/sources/${SRC}/extract`).send({});
    expect(res.status).toBe(409);
    expect(res.body.setup).toContain('nothing is sent to an external AI');
    expect(createExtractRun).not.toHaveBeenCalled();
  });

  it('409 while another extraction runs; 400 for an unknown mode', async () => {
    findActiveExtraction.mockResolvedValue({ id: RUN });
    expect((await request(app).post(`/api/org-truth/knowledge/sources/${SRC}/extract`).send({})).body).toMatchObject({ runId: RUN });
    expect((await request(app).post(`/api/org-truth/knowledge/sources/${SRC}/extract`).send({ mode: 'turbo' })).status).toBe(400);
  });
});

describe('runs', () => {
  it('a run is returned without its stage cache; diagnostics include it', async () => {
    getRun.mockResolvedValue({ id: RUN, status: 'running', details: { cache: { a: 1, b: 2 }, model: 'qwen' } });
    const res = await request(app).get(`/api/org-truth/knowledge/runs/${RUN}`);
    expect(res.body).toMatchObject({ id: RUN, cachedCalls: 2, details: { model: 'qwen' } });
    expect(res.body.details.cache).toBeUndefined();
    expect((await request(app).get(`/api/org-truth/knowledge/runs/${RUN}/diagnostics`)).body.details.cache).toEqual({ a: 1, b: 2 });
    getRun.mockResolvedValue(null);
    expect((await request(app).get(`/api/org-truth/knowledge/runs/${RUN}`)).status).toBe(404);
  });

  it('cancel answers 409 for a run that is not active', async () => {
    requestCancel.mockResolvedValueOnce({ id: RUN }).mockResolvedValueOnce(null);
    expect((await request(app).post(`/api/org-truth/knowledge/runs/${RUN}/cancel`)).body).toEqual({ id: RUN, cancelRequested: true });
    expect((await request(app).post(`/api/org-truth/knowledge/runs/${RUN}/cancel`)).status).toBe(409);
    expect((await request(app).post('/api/org-truth/knowledge/runs/nope/cancel')).status).toBe(404);
  });

  it('status reports the model, the active run and a setup hint when none is configured', async () => {
    modelStatus.mockResolvedValue({ configured: false, reachable: false, model: null, state: null });
    findActiveExtraction.mockResolvedValue({ id: RUN });
    const res = await request(app).get('/api/org-truth/knowledge/status');
    expect(res.body).toMatchObject({ configured: false, activeRunId: RUN });
    expect(res.body.setup).toContain('NL_REPORTS_LLM_URL');
  });
});
