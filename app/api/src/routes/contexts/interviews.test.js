// Route tests for the context interviews: the gate on every write, what a
// reader without write access gets, the file intake, and failures → answers.
// The steps themselves are contexts/interviews/*.test.js's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (...required) => (req, res, next) => (required.some(p => req.user?.permissions?.includes(p)) ? next() : res.status(403).json({ error: 'Insufficient permissions' })),
}));
let authOn = true;
vi.mock('../../config/authConfig.js', () => ({ isAuthEnabled: () => authOn }));
vi.mock('../../db/connection.js');
vi.mock('../../contexts/interviews/service.js', async (orig) => ({
  ...(await orig()),
  createInterview: vi.fn(), retryExtraction: vi.fn(), addManualClaim: vi.fn(), claimsOf: vi.fn(),
  interviewWithTranscript: vi.fn(), rejectMany: vi.fn(),
}));
vi.mock('../../contexts/interviews/decide.js', async (orig) => ({ ...(await orig()), decideClaim: vi.fn(), undoClaim: vi.fn() }));
vi.mock('../../contexts/interviews/store.js', async (orig) => ({
  ...(await orig()), listInterviews: vi.fn(), getInterview: vi.fn(), deleteInterview: vi.fn(), mentionsOf: vi.fn(),
}));
process.env.USE_SQL = 'true';

const { default: router, canWriteContexts, statusesFor, MAX_TRANSCRIPT_BYTES } = await import('./interviews.js');
const service = await import('../../contexts/interviews/service.js');
const { decideClaim, undoClaim, ClaimError } = await import('../../contexts/interviews/decide.js');
const store = await import('../../contexts/interviews/store.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const IV = 'ffffffff-0000-4000-8000-000000000001';
const CLAIM = 'cccccccc-0000-4000-8000-000000000001';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';

const analyst = { email: 'analyst@example.test', permissions: ['data.read', 'data.write.contexts'] };
const reader = { email: 'reader@example.test', permissions: ['data.read'] };
let caller = analyst;
const app = mountRouterAs(router, () => caller);

beforeEach(() => {
  caller = analyst;
  authOn = true;
  for (const f of [service.createInterview, service.retryExtraction, service.addManualClaim, service.claimsOf, decideClaim, undoClaim,
    store.listInterviews, store.getInterview, store.deleteInterview, store.mentionsOf,
    service.interviewWithTranscript, service.rejectMany]) vi.mocked(f).mockReset();
});

describe('canWriteContexts', () => {
  it('open mode is a writer; a read token or a context owner never is; a Set or a list of permissions both read', () => {
    authOn = false;
    expect(canWriteContexts({})).toBe(true);
    authOn = true;
    expect(canWriteContexts({ user: { permissions: new Set(['data.write.contexts']) } })).toBe(true);
    expect(canWriteContexts({ user: { permissions: ['admin.context-plugins'] } })).toBe(true);
    expect(canWriteContexts({ user: { permissions: new Set(['*']) } })).toBe(true);
    expect(canWriteContexts({ user: { permissions: new Set(['data.read']) } })).toBe(false);
    expect(canWriteContexts({ readToken: true, user: { permissions: new Set(['*']) } })).toBe(false);
    expect(canWriteContexts({ user: { contextOwner: { contextIds: new Set() }, permissions: new Set(['*']) } })).toBe(false);
    expect(canWriteContexts({ user: {} })).toBe(false);
  });
});

describe('statusesFor', () => {
  it('a writer gets what they ask (all when nothing), a reader only decided-and-confirmed claims', () => {
    expect(statusesFor(undefined, true)).toEqual(['proposed', 'confirmed', 'rejected', 'edited']);
    expect(statusesFor('proposed, bogus', true)).toEqual(['proposed']);
    expect(statusesFor(undefined, false)).toEqual(['confirmed', 'edited']);
    expect(statusesFor('proposed,rejected', false)).toEqual([]);
  });
});

describe('the gate', () => {
  it.each([
    ['post', `/api/contexts/${CTX}/interviews`],
    ['get', `/api/contexts/${CTX}/interviews`],
    ['get', `/api/contexts/${CTX}/interviews/${IV}`],
    ['post', `/api/contexts/${CTX}/interviews/${IV}/extract`],
    ['post', `/api/contexts/${CTX}/interviews/${IV}/claims`],
    ['delete', `/api/contexts/${CTX}/interviews/${IV}`],
    ['patch', `/api/contexts/claims/${CLAIM}`],
    ['post', `/api/contexts/${CTX}/claims/reject`],
  ])('%s %s is 403 for a reader and reaches nothing', async (method, path) => {
    caller = reader;
    expect((await request(app)[method](path).send({})).status).toBe(403);
    expect(service.createInterview).not.toHaveBeenCalled();
    expect(decideClaim).not.toHaveBeenCalled();
    expect(store.listInterviews).not.toHaveBeenCalled();
    expect(service.rejectMany).not.toHaveBeenCalled();
  });
});

describe('POST /contexts/:id/interviews', () => {
  it('hands the file, the form fields and the caller to the service, and answers 201', async () => {
    vi.mocked(service.createInterview).mockResolvedValue({ id: IV, extractionStatus: 'pending' });
    const res = await request(app).post(`/api/contexts/${CTX}/interviews`)
      .field('principalId', ANNA).field('interviewedAt', '2026-10-01')
      .attach('file', Buffer.from('Anna: hello'), 'gesprek.vtt');
    expect(res.status).toBe(201);
    const [arg] = vi.mocked(service.createInterview).mock.calls[0];
    expect(arg).toMatchObject({ contextId: CTX, body: { principalId: ANNA, interviewedAt: '2026-10-01' }, user: 'analyst@example.test' });
    expect(arg.file.originalname).toBe('gesprek.vtt');
    expect(arg.file.buffer.toString()).toBe('Anna: hello');
  });

  it('takes a list (csv, xlsx) as a file, and pasted text without a file', async () => {
    vi.mocked(service.createInterview).mockResolvedValue({ id: IV });
    expect((await request(app).post(`/api/contexts/${CTX}/interviews`).field('interviewedAt', '2026-10-01')
      .attach('file', Buffer.from('Name;Role'), 'team.csv')).status).toBe(201);
    expect((await request(app).post(`/api/contexts/${CTX}/interviews`).attach('file', Buffer.from('PK'), 'team.xlsx')).status).toBe(201);
    const pasted = await request(app).post(`/api/contexts/${CTX}/interviews`).field('interviewedAt', '2026-10-01').field('text', 'Piet left in May.');
    expect(pasted.status).toBe(201);
    const [arg] = vi.mocked(service.createInterview).mock.calls[2];
    expect(arg.file).toBeUndefined();
    expect(arg.body).toEqual({ interviewedAt: '2026-10-01', text: 'Piet left in May.' });
  });

  it('refuses a file type it cannot read, no file and no text, blank text, and a bad id before the service', async () => {
    const pdf = await request(app).post(`/api/contexts/${CTX}/interviews`).attach('file', Buffer.from('%PDF'), 'gesprek.pdf');
    expect([pdf.status, pdf.body.error]).toEqual([400, 'Add a file as .txt, .md, .docx, .vtt, .srt, .csv or .xlsx.']);
    const none = await request(app).post(`/api/contexts/${CTX}/interviews`).field('principalId', ANNA);
    expect([none.status, none.body.error]).toEqual([400, 'Add a file (field "file") or paste the text (field "text").']);
    const blank = await request(app).post(`/api/contexts/${CTX}/interviews`).field('text', '   ');
    expect(blank.status).toBe(400);
    expect((await request(app).post('/api/contexts/nope/interviews').attach('file', Buffer.from('x'), 'a.txt')).status).toBe(400);
    expect(service.createInterview).not.toHaveBeenCalled();
  });

  it('a file over the cap is 413', async () => {
    const res = await request(app).post(`/api/contexts/${CTX}/interviews`).attach('file', Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1, 97), 'big.txt');
    expect(res.status).toBe(413);
  });

  it('answers the service\'s own refusal with its status and sentence, anything else with a generic 500', async () => {
    const { InterviewError } = await import('../../contexts/interviews/service.js');
    vi.mocked(service.createInterview).mockRejectedValueOnce(new InterviewError(404, 'Principal not found'));
    const a = await request(app).post(`/api/contexts/${CTX}/interviews`).attach('file', Buffer.from('x'), 'a.txt');
    expect([a.status, a.body]).toEqual([404, { error: 'Principal not found' }]);
    vi.mocked(service.createInterview).mockRejectedValueOnce(new Error('relation "ContextInterviews" does not exist'));
    const b = await request(app).post(`/api/contexts/${CTX}/interviews`).attach('file', Buffer.from('x'), 'a.txt');
    expect([b.status, b.body]).toEqual([500, { error: 'Uploading the interview failed' }]);
  });
});

describe('interview reads and deletes', () => {
  it('lists, reads one (404 when not this context\'s), and deletes (204 / 404)', async () => {
    vi.mocked(store.listInterviews).mockResolvedValue([{ id: IV }]);
    expect((await request(app).get(`/api/contexts/${CTX}/interviews`)).body).toEqual({ data: [{ id: IV }] });
    const { InterviewError } = await import('../../contexts/interviews/service.js');
    vi.mocked(service.interviewWithTranscript).mockResolvedValueOnce({ id: IV, transcript: 't', highlights: [] })
      .mockRejectedValueOnce(new InterviewError(404, 'Interview not found'));
    expect((await request(app).get(`/api/contexts/${CTX}/interviews/${IV}`)).body).toEqual({ id: IV, transcript: 't', highlights: [] });
    expect(vi.mocked(service.interviewWithTranscript).mock.calls[0].slice(0, 2)).toEqual([CTX, IV]);
    const missing = await request(app).get(`/api/contexts/${CTX}/interviews/${IV}`);
    expect([missing.status, missing.body]).toEqual([404, { error: 'Interview not found' }]);
    vi.mocked(store.deleteInterview).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect((await request(app).delete(`/api/contexts/${CTX}/interviews/${IV}`)).status).toBe(204);
    expect((await request(app).delete(`/api/contexts/${CTX}/interviews/${IV}`)).status).toBe(404);
  });

  it('retry answers 202; a manual claim 201', async () => {
    vi.mocked(service.retryExtraction).mockResolvedValue({ id: IV, extractionStatus: 'pending' });
    expect((await request(app).post(`/api/contexts/${CTX}/interviews/${IV}/extract`)).status).toBe(202);
    vi.mocked(service.addManualClaim).mockResolvedValue({ id: CLAIM });
    const res = await request(app).post(`/api/contexts/${CTX}/interviews/${IV}/claims`).send({ kind: 'description', value: 'x' });
    expect(res.status).toBe(201);
    expect(vi.mocked(service.addManualClaim).mock.calls[0].slice(0, 3)).toEqual([CTX, IV, { kind: 'description', value: 'x' }]);
  });
});

describe('GET /contexts/:id/claims', () => {
  it('a writer gets the statuses asked for', async () => {
    vi.mocked(service.claimsOf).mockResolvedValue({ data: [], accountableDoubt: null });
    await request(app).get(`/api/contexts/${CTX}/claims?status=proposed`);
    expect(vi.mocked(service.claimsOf).mock.calls[0][1]).toEqual({ statuses: ['proposed'] });
  });

  it('a reader without write access gets confirmed claims only, whatever they ask', async () => {
    caller = reader;
    vi.mocked(service.claimsOf).mockResolvedValue({ data: [], accountableDoubt: null });
    const res = await request(app).get(`/api/contexts/${CTX}/claims?status=proposed,confirmed`);
    expect(res.status).toBe(200);
    expect(vi.mocked(service.claimsOf).mock.calls[0][1]).toEqual({ statuses: ['confirmed'] });
  });
});

describe('PATCH /contexts/claims/:claimId', () => {
  it('decides with the body and the caller', async () => {
    vi.mocked(decideClaim).mockResolvedValue({ claim: { id: CLAIM }, effect: { kind: 'none' } });
    const res = await request(app).patch(`/api/contexts/claims/${CLAIM}`).send({ status: 'rejected' });
    expect(res.body).toEqual({ claim: { id: CLAIM }, effect: { kind: 'none' } });
    expect(vi.mocked(decideClaim).mock.calls[0].slice(1)).toEqual([CLAIM, { status: 'rejected' }, 'analyst@example.test']);
  });

  it('an Accountable conflict is a 409 that carries the current holder', async () => {
    vi.mocked(decideClaim).mockRejectedValue(new ClaimError(409, 'This context already has an Accountable', { current: { displayName: 'Anna Voorbeeld' } }));
    const res = await request(app).patch(`/api/contexts/claims/${CLAIM}`).send({ status: 'confirmed' });
    expect([res.status, res.body]).toEqual([409, { error: 'This context already has an Accountable', details: { current: { displayName: 'Anna Voorbeeld' } } }]);
  });
});

describe('POST /contexts/claims/:claimId/undo', () => {
  it('reopens the claim and says whether a former-member mark was removed', async () => {
    vi.mocked(undoClaim).mockResolvedValue({ claim: { id: CLAIM, status: 'proposed' }, unmarked: true });
    const res = await request(app).post(`/api/contexts/claims/${CLAIM}/undo`);
    expect([res.status, res.body]).toEqual([200, { claim: { id: CLAIM, status: 'proposed' }, unmarked: true }]);
    expect(vi.mocked(undoClaim).mock.calls[0][1]).toBe(CLAIM);
  });

  it('a decision that changed the context is a 409; a bad id never reaches it; a reader is refused', async () => {
    vi.mocked(undoClaim).mockRejectedValue(new ClaimError(409, 'This decision changed the context; change it there instead'));
    expect((await request(app).post(`/api/contexts/claims/${CLAIM}/undo`)).status).toBe(409);
    vi.mocked(undoClaim).mockClear();
    expect((await request(app).post('/api/contexts/claims/nope/undo')).status).toBe(400);
    caller = reader;
    expect((await request(app).post(`/api/contexts/claims/${CLAIM}/undo`)).status).toBe(403);
    expect(undoClaim).not.toHaveBeenCalled();
  });
});

describe('GET /contexts/claims/mentions', () => {
  it('needs a holder id; a writer sees proposed mentions too, a reader confirmed ones only', async () => {
    expect((await request(app).get('/api/contexts/claims/mentions')).status).toBe(400);
    expect((await request(app).get('/api/contexts/claims/mentions?principalId=x')).status).toBe(400);
    vi.mocked(store.mentionsOf).mockResolvedValue([{ contextId: CTX }]);
    const res = await request(app).get(`/api/contexts/claims/mentions?identityId=${ANNA.toUpperCase()}`);
    expect(res.body).toEqual({ data: [{ contextId: CTX }] });
    expect(vi.mocked(store.mentionsOf).mock.calls[0].slice(1)).toEqual(['identityId', ANNA, ['proposed', 'confirmed', 'edited']]);
    caller = reader;
    await request(app).get(`/api/contexts/claims/mentions?principalId=${ANNA}`);
    expect(vi.mocked(store.mentionsOf).mock.calls[1].slice(1)).toEqual(['principalId', ANNA, ['confirmed', 'edited']]);
  });
});

describe('POST /contexts/:id/claims/reject', () => {
  it('hands the body and the caller to the service; its refusal keeps its status', async () => {
    vi.mocked(service.rejectMany).mockResolvedValueOnce({ rejected: 3, ids: ['a', 'b', 'c'] });
    const res = await request(app).post(`/api/contexts/${CTX}/claims/reject`).send({ relevance: 'low' });
    expect([res.status, res.body]).toEqual([200, { rejected: 3, ids: ['a', 'b', 'c'] }]);
    expect(vi.mocked(service.rejectMany).mock.calls[0].slice(0, 3)).toEqual([CTX, { relevance: 'low' }, 'analyst@example.test']);
    const { InterviewError } = await import('../../contexts/interviews/service.js');
    vi.mocked(service.rejectMany).mockRejectedValueOnce(new InterviewError(400, 'Say which claims to reject: a kind, a relevance, or both.'));
    const bad = await request(app).post(`/api/contexts/${CTX}/claims/reject`).send({});
    expect([bad.status, bad.body.error]).toEqual([400, 'Say which claims to reject: a kind, a relevance, or both.']);
  });
});
