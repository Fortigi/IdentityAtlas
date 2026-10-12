import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../db/connection.js');
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (perm) => (req, res, next) => (req.headers['x-deny'] === perm ? res.status(403).json({ denied: perm }) : next()),
}));
vi.mock('../../config/authConfig.js', () => ({ isAuthEnabled: () => true }));
vi.mock('../knowledge/store.js', () => ({ getTranscript: vi.fn() }));
vi.mock('../knowledge/read.js', () => ({
  listMentions: vi.fn(async () => [{ id: 'm' }]), listClaims: vi.fn(async () => [{ id: 'c' }]), listFindings: vi.fn(async () => [{ id: 'f' }]),
  exportPackage: vi.fn(async () => ({ schemaVersion: '0.1' })), statementsAbout: vi.fn(async () => [{ id: 's' }]),
}));
vi.mock('../knowledge/resolve.js', () => ({ resolveMentions: vi.fn(async () => new Map([['q', { status: 'candidates', candidates: [{ label: 'Rob Visser' }] }]])) }));
vi.mock('../knowledge/review.js', async () => {
  const actual = await vi.importActual('../knowledge/review.js');
  return { ...actual, reviewMatch: vi.fn(), reviewClaim: vi.fn(), reviewFinding: vi.fn(), bulkReviewClaims: vi.fn() };
});
vi.mock('../knowledge/mentions.js', () => ({ editMention: vi.fn() }));
vi.mock('../knowledge/corroboration.js', () => ({ rescoreSource: vi.fn(async () => ({ scored: 4, corroborated: 2, contradicted: 1 })), rescoreForMention: vi.fn(async () => ({ scored: 4, corroborated: 2, contradicted: 1 })) }));
vi.mock('../import/sourceStore.js', () => ({ getSourceWithContent: vi.fn() }));
vi.mock('../model/linkedTo.js', () => ({ targetsOf: vi.fn(async (t, id) => [{ targetType: t, id }, { targetType: 'Principal', id: 'acc' }]) }));

import { mountRouterAs } from '../../../test-utils/routeTestKit.js';
import router from './knowledgeReview.js';
import { getTranscript } from '../knowledge/store.js';
import { listClaims, statementsAbout } from '../knowledge/read.js';
import { resolveMentions } from '../knowledge/resolve.js';
import { reviewMatch, reviewClaim, bulkReviewClaims, KnowledgeReviewError } from '../knowledge/review.js';
import { editMention } from '../knowledge/mentions.js';
import { rescoreSource, rescoreForMention } from '../knowledge/corroboration.js';
import { getSourceWithContent } from '../import/sourceStore.js';

const SRC = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const app = mountRouterAs(router, () => ({ preferred_username: 'wim', permissions: new Set(['data.read']) }));

beforeEach(() => {
  process.env.FEATURE_ORG_TRUTH = 'true';
  process.env.FEATURE_KNOWLEDGE_EXTRACTION = 'true';
  vi.clearAllMocks();
  getTranscript.mockResolvedValue({ id: SRC, metadata: {} });
});

describe('reading', () => {
  it.each(['mentions', 'claims', 'findings'])('GET /sources/:id/%s returns the list', async (what) => {
    const res = await request(app).get(`/api/org-truth/knowledge/sources/${SRC}/${what}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('claims can be filtered by status; an unknown status is a 400', async () => {
    await request(app).get(`/api/org-truth/knowledge/sources/${SRC}/claims?status=accepted`);
    expect(listClaims).toHaveBeenCalledWith(SRC, { status: 'accepted' });
    expect((await request(app).get(`/api/org-truth/knowledge/sources/${SRC}/claims?status=maybe`)).status).toBe(400);
  });

  it('a restricted transcript of someone else is not found', async () => {
    getTranscript.mockResolvedValue({ id: SRC, uploadedBy: 'gregor', metadata: { classification: 'restricted' } });
    expect((await request(app).get(`/api/org-truth/knowledge/sources/${SRC}/claims`)).status).toBe(404);
    expect((await request(app).get(`/api/org-truth/knowledge/sources/${SRC}/export`)).status).toBe(404);
  });

  it('export is a JSON attachment', async () => {
    const res = await request(app).get(`/api/org-truth/knowledge/sources/${SRC}/export`);
    expect(res.headers['content-disposition']).toContain(`knowledge-${SRC}.json`);
    expect(res.body).toEqual({ schemaVersion: '0.1' });
  });

  it('search resolves one label of one mention type', async () => {
    const res = await request(app).get('/api/org-truth/knowledge/search?type=person&q=Rob');
    expect(res.body.candidates[0].label).toBe('Rob Visser');
    expect(resolveMentions).toHaveBeenCalledWith([{ key: 'q', type: 'person', label: 'Rob' }]);
    expect((await request(app).get('/api/org-truth/knowledge/search?type=planet&q=Rob')).status).toBe(400);
    expect((await request(app).get('/api/org-truth/knowledge/search?type=person&q=R')).status).toBe(400);
  });

  it('statements about an identity also look at its accounts; an org entity only at itself', async () => {
    await request(app).get(`/api/org-truth/knowledge/statements?targetType=Identity&targetId=${ID}`);
    expect(statementsAbout).toHaveBeenLastCalledWith([{ targetType: 'Identity', id: ID }, { targetType: 'Principal', id: 'acc' }]);
    await request(app).get(`/api/org-truth/knowledge/statements?targetType=OrgEntity&targetId=${ID}`);
    expect(statementsAbout).toHaveBeenLastCalledWith([{ targetType: 'OrgEntity', id: ID }]);
    expect((await request(app).get('/api/org-truth/knowledge/statements?targetType=Planet&targetId=x')).status).toBe(400);
  });
});

describe('original transcript', () => {
  it('returns the uploaded bytes for a visible transcript, 404 for a restricted one of someone else', async () => {
    getSourceWithContent.mockResolvedValue({ id: SRC, fileName: 'wim.srt', mimeType: 'text/plain', content: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhoi\n') });
    const res = await request(app).get(`/api/org-truth/knowledge/sources/${SRC}/original`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('wim.srt');
    expect(res.text).toContain('00:00:01,000');
    getTranscript.mockResolvedValue({ id: SRC, uploadedBy: 'gregor', metadata: { classification: 'restricted' } });
    expect((await request(app).get(`/api/org-truth/knowledge/sources/${SRC}/original`)).status).toBe(404);
  });
});

describe('editing a mention and bulk review', () => {
  it('passes the edit and the bulk decision through', async () => {
    editMention.mockResolvedValue({ mention: { id: ID, label: 'Fortigi' }, candidates: [] });
    const ed = await request(app).put(`/api/org-truth/knowledge/mentions/${ID}`).send({ label: 'Fortigi', type: 'organisation', extra: 1 });
    expect(ed.body.mention.label).toBe('Fortigi');
    expect(editMention).toHaveBeenCalledWith(ID, { label: 'Fortigi', type: 'organisation' }, 'wim');
    expect(rescoreForMention).toHaveBeenCalledWith(ID);
    expect(ed.body.confidence).toEqual({ scored: 4, corroborated: 2, contradicted: 1 });
    const rs = await request(app).post(`/api/org-truth/knowledge/sources/${SRC}/rescore`);
    expect(rs.body).toEqual({ scored: 4, corroborated: 2, contradicted: 1 });
    expect(rescoreSource).toHaveBeenCalledWith(SRC);
    bulkReviewClaims.mockResolvedValue({ status: 'rejected', updated: 3, ids: [] });
    const bulk = await request(app).put(`/api/org-truth/knowledge/sources/${SRC}/claims/bulk`).send({ status: 'rejected', ids: [ID] });
    expect(bulk.body.updated).toBe(3);
    expect(bulkReviewClaims).toHaveBeenCalledWith(SRC, { status: 'rejected', ids: [ID] }, 'wim');
    bulkReviewClaims.mockRejectedValue(new KnowledgeReviewError(400, 'status must be accepted or rejected.'));
    expect((await request(app).put(`/api/org-truth/knowledge/sources/${SRC}/claims/bulk`).send({ status: 'x' })).status).toBe(400);
  });
});

describe('deciding', () => {
  it.each([
    ['put', `/api/org-truth/knowledge/matches/${ID}`],
    ['put', `/api/org-truth/knowledge/claims/${ID}`],
    ['put', `/api/org-truth/knowledge/findings/${ID}`],
  ])('%s %s needs data.write.contexts', async (method, path) => {
    expect((await request(app)[method](path).set('x-deny', 'data.write.contexts').send({})).status).toBe(403);
  });

  it('passes the decision and the actor through, and maps review errors to their status', async () => {
    reviewMatch.mockResolvedValue({ link: { id: ID, status: 'accepted' } });
    const ok = await request(app).put(`/api/org-truth/knowledge/matches/${ID}`).send({ action: 'confirm' });
    expect(ok.body).toEqual({ link: { id: ID, status: 'accepted' } });
    expect(rescoreForMention).not.toHaveBeenCalled(); // the stub link carries no orgEntityId
    expect(reviewMatch).toHaveBeenCalledWith(ID, { action: 'confirm' }, 'wim');
    reviewClaim.mockRejectedValue(new KnowledgeReviewError(409, 'already decided'));
    const conflict = await request(app).put(`/api/org-truth/knowledge/claims/${ID}`).send({ status: 'accepted', expectedStatus: 'proposed' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: 'already decided' });
  });

  it('an unexpected error is a JSON 500, not a crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reviewClaim.mockRejectedValue(new Error('db down'));
    const res = await request(app).put(`/api/org-truth/knowledge/claims/${ID}`).send({ status: 'accepted' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to review the statement.');
  });
});
