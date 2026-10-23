// The steps behind the routes: what an upload stores and starts, when a retry
// is refused, an analyst's own claim, and what a claims list carries.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', async (orig) => ({
  ...(await orig()),
  insertInterview: vi.fn(), getInterview: vi.fn(), setExtraction: vi.fn(), insertClaims: vi.fn(),
  getClaimRow: vi.fn(), listClaims: vi.fn(), currentAccountable: vi.fn(),
}));
const store = await import('./store.js');
const { createInterview, retryExtraction, addManualClaim, claimsOf, validDate, parseInterviewee, InterviewError, STALE_RUN_MS } = await import('./service.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const IV = 'ffffffff-0000-4000-8000-000000000001';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';

const TRANSCRIPT = 'Anna Voorbeeld: Ik ben de eigenaar van deze applicatie, maar Piet doet het dagelijkse werk.';

// queryOne answers by table: the context, and the interviewee.
function fakeDb({ context = { id: CTX, contextCategory: 'LogicalApplication' }, person = { displayName: 'Anna Voorbeeld' } } = {}) {
  return {
    queryOne: vi.fn(async (sql) => (sql.includes('"Contexts"') ? context : person)),
    query: vi.fn(async () => ({ rows: [] })),
  };
}

const file = (text = TRANSCRIPT, name = 'gesprek.txt') => ({ buffer: Buffer.from(text), originalname: name });

beforeEach(() => {
  for (const k of ['insertInterview', 'getInterview', 'setExtraction', 'insertClaims', 'getClaimRow', 'listClaims', 'currentAccountable']) store[k].mockReset();
  store.insertInterview.mockImplementation(async (_db, row) => ({ id: IV, ...row }));
});

describe('validDate / parseInterviewee', () => {
  it('takes a calendar date that exists, nothing else', () => {
    expect(validDate(' 2026-02-28 ')).toBe('2026-02-28');
    for (const bad of ['2026-02-30', '2026-2-3', '28-02-2026', '', null]) expect(validDate(bad)).toBeNull();
  });

  it('wants exactly one interviewee, as a uuid', () => {
    expect(parseInterviewee({ identityId: ANNA.toUpperCase() })).toEqual({ col: 'identityId', id: ANNA });
    expect(() => parseInterviewee({})).toThrow(/exactly one/);
    expect(() => parseInterviewee({ principalId: ANNA, identityId: PIET })).toThrow(/exactly one/);
    expect(() => parseInterviewee({ principalId: 'x' })).toThrow('principalId must be a uuid');
  });
});

describe('createInterview', () => {
  const body = { principalId: ANNA, interviewedAt: '2026-10-01' };

  it('stores the transcript as text with its language and starts the extraction when a model is there', async () => {
    const start = vi.fn();
    const db = fakeDb();
    const r = await createInterview({ contextId: CTX, file: file(), body, user: 'analyst@example.test' }, { db, enabled: () => true, start });
    expect(store.insertInterview.mock.calls[0][1]).toEqual({
      contextId: CTX, principalId: ANNA, intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', fileName: 'gesprek.txt',
      transcript: TRANSCRIPT, language: 'nl', extractionStatus: 'pending', createdBy: 'analyst@example.test',
    });
    expect(start).toHaveBeenCalledWith(IV, { db });
    expect(r.llmConfigured).toBe(true);
  });

  it('without a model: stored as notConfigured, nothing started — the analyst adds claims by hand', async () => {
    const start = vi.fn();
    const r = await createInterview({ contextId: CTX, file: file('We are a customer since 2019.'), body, user: 'u' }, { db: fakeDb(), enabled: () => false, start });
    expect(store.insertInterview.mock.calls[0][1]).toMatchObject({ extractionStatus: 'notConfigured', language: 'en' });
    expect(start).not.toHaveBeenCalled();
    expect(r.llmConfigured).toBe(false);
  });

  it('refuses a missing context, a Tag, a missing date, an unknown interviewee and an unreadable file, writing nothing', async () => {
    const opts = { enabled: () => true, start: vi.fn() };
    const run = (db, over = {}) => createInterview({ contextId: CTX, file: file(), body, user: 'u', ...over }, { ...opts, db });
    await expect(run(fakeDb({ context: null }))).rejects.toMatchObject({ status: 404, message: 'Context not found' });
    await expect(run(fakeDb({ context: { id: CTX, contextCategory: 'Tag' } }))).rejects.toMatchObject({ status: 400 });
    await expect(run(fakeDb(), { body: { principalId: ANNA } })).rejects.toMatchObject({ status: 400, message: /when the interview/ });
    await expect(run(fakeDb({ person: null }))).rejects.toMatchObject({ status: 404, message: 'Principal not found' });
    await expect(run(fakeDb({ person: null }), { body: { identityId: ANNA, interviewedAt: '2026-10-01' } })).rejects.toMatchObject({ status: 404, message: 'Identity not found' });
    await expect(run(fakeDb(), { file: file('   ') })).rejects.toThrow('The transcript holds no text.');
    await expect(run(fakeDb(), { contextId: 'nope' })).rejects.toBeInstanceOf(InterviewError);
    expect(store.insertInterview).not.toHaveBeenCalled();
    expect(opts.start).not.toHaveBeenCalled();
  });
});

describe('retryExtraction', () => {
  const now = Date.parse('2026-10-23T10:00:00Z');
  const interview = (over) => ({ id: IV, extractionStatus: 'failed', extractionStartedAt: null, ...over });

  it('starts again and answers pending', async () => {
    store.getInterview.mockResolvedValue(interview());
    const start = vi.fn();
    const r = await retryExtraction(CTX, IV, { db: fakeDb(), enabled: () => true, start }, now);
    expect(r.extractionStatus).toBe('pending');
    expect(store.setExtraction.mock.calls[0][2]).toEqual({ status: 'pending' });
    expect(start).toHaveBeenCalledWith(IV, expect.anything());
  });

  it('refuses while a fresh run is going, but not one stuck since before a restart', async () => {
    const start = vi.fn();
    const deps = { db: fakeDb(), enabled: () => true, start };
    store.getInterview.mockResolvedValue(interview({ extractionStatus: 'running', extractionStartedAt: new Date(now - STALE_RUN_MS + 1000).toISOString() }));
    await expect(retryExtraction(CTX, IV, deps, now)).rejects.toMatchObject({ status: 409 });
    store.getInterview.mockResolvedValue(interview({ extractionStatus: 'running', extractionStartedAt: new Date(now - STALE_RUN_MS).toISOString() }));
    await retryExtraction(CTX, IV, deps, now);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('is 404 for another context\'s interview and 503 without a model', async () => {
    store.getInterview.mockResolvedValue(null);
    await expect(retryExtraction(CTX, IV, { db: fakeDb(), enabled: () => true }, now)).rejects.toMatchObject({ status: 404 });
    store.getInterview.mockResolvedValue(interview());
    await expect(retryExtraction(CTX, IV, { db: fakeDb(), enabled: () => false }, now)).rejects.toMatchObject({ status: 503 });
  });
});

describe('addManualClaim', () => {
  beforeEach(() => {
    store.getInterview.mockResolvedValue({ id: IV, principalId: ANNA, identityId: null, intervieweeName: 'Anna Voorbeeld', transcript: TRANSCRIPT });
    store.insertClaims.mockResolvedValue(['new-claim']);
    store.getClaimRow.mockResolvedValue({ id: 'new-claim' });
  });

  it('stores an analyst\'s role claim about the interviewee with the deduced suggestion and the verbatim quote', async () => {
    const r = await addManualClaim(CTX, IV, { kind: 'role', subject: 'ik', relation: 'owner', value: 'eigenaar', quote: 'Ik ben de eigenaar van deze applicatie' }, { db: fakeDb() });
    expect(r).toEqual({ id: 'new-claim' });
    const [, scope, [claim]] = store.insertClaims.mock.calls[0];
    expect(scope).toEqual({ interviewId: IV, contextId: CTX, proposedBy: 'analyst' });
    expect(claim).toMatchObject({ principalId: ANNA, subjectMatch: 'interviewee', roleSuggestion: 'Accountable', quote: 'Ik ben de eigenaar van deze applicatie' });
  });

  it('takes an analyst\'s own suggestion over the deduced one, and needs no quote', async () => {
    await addManualClaim(CTX, IV, { kind: 'role', subject: 'ik', relation: 'member', value: 'beheer', roleSuggestion: 'Responsible' }, { db: fakeDb() });
    expect(store.insertClaims.mock.calls[0][2][0]).toMatchObject({ roleSuggestion: 'Responsible', quote: null });
  });

  it('refuses a quote that is not in the transcript, an unknown suggestion and another context\'s interview', async () => {
    await expect(addManualClaim(CTX, IV, { kind: 'description', value: 'x', quote: 'Dit is nooit gezegd' }, { db: fakeDb() })).rejects.toMatchObject({ status: 400, message: /verbatim/ });
    await expect(addManualClaim(CTX, IV, { kind: 'role', subject: 'ik', value: 'x', roleSuggestion: 'Boss' }, { db: fakeDb() })).rejects.toMatchObject({ status: 400 });
    store.getInterview.mockResolvedValue(null);
    await expect(addManualClaim(CTX, IV, { kind: 'description', value: 'x' }, { db: fakeDb() })).rejects.toMatchObject({ status: 404 });
    expect(store.insertClaims).not.toHaveBeenCalled();
  });
});

describe('claimsOf', () => {
  it('lists the claims in the given statuses and names the claim that doubts the Accountable', async () => {
    const doubt = { id: 'c2', claimKind: 'role', attribute: 'notOwner', principalId: ANNA, status: 'proposed', quote: 'Ik ben niet de eigenaar', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' };
    store.listClaims.mockResolvedValue([{ id: 'c1', claimKind: 'description' }, doubt]);
    store.currentAccountable.mockResolvedValue({ id: 'r1', principalId: ANNA });
    const r = await claimsOf(CTX, { statuses: ['proposed'] }, { db: fakeDb() });
    expect(store.listClaims.mock.calls[0].slice(1)).toEqual([CTX, ['proposed']]);
    expect(r.accountableDoubt).toEqual({ claimId: 'c2', quote: 'Ik ben niet de eigenaar', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' });
    expect(r.data).toHaveLength(2);
  });

  it('no doubt without an Accountable; 404 for an unknown context', async () => {
    store.listClaims.mockResolvedValue([]);
    store.currentAccountable.mockResolvedValue(null);
    expect((await claimsOf(CTX, { statuses: ['confirmed'] }, { db: fakeDb() })).accountableDoubt).toBeNull();
    await expect(claimsOf(CTX, { statuses: [] }, { db: fakeDb({ context: null }) })).rejects.toMatchObject({ status: 404 });
  });
});
