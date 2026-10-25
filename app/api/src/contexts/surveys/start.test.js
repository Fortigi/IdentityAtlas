// Doing a survey in place (start.js), with the SQL module mocked: who may start
// one and for whom, what the request is (not sent, opened at once), picking a
// left one up again, and that the ordinary submit records the answers as the
// respondent's — on their behalf when someone else filled them in.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', async (orig) => {
  const real = await orig();
  const fns = Object.fromEntries(Object.entries(real).filter(([, v]) => typeof v === 'function').map(([k]) => [k, vi.fn()]));
  return { ...real, ...fns };
});
vi.mock('../interviews/store.js', async (orig) => ({ ...(await orig()), insertInterview: vi.fn(), insertClaims: vi.fn() }));

const store = await import('./store.js');
const interviewStore = await import('../interviews/store.js');
const start = await import('./start.js');
const svc = await import('./service.js');
const { SEED_TEMPLATES } = await import('./seedTemplates.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const TPL = 'eeeeeeee-0000-4000-8000-000000000001';
const OTHER_TPL = 'eeeeeeee-0000-4000-8000-000000000002';
const REQ = 'ffffffff-0000-4000-8000-000000000001';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const ANNA_PERSON = 'bbbbbbbb-0000-4000-8000-000000000001';

const intake = SEED_TEMPLATES.find(t => t.key === 'application-intake').definition;
const db = () => ({ tx: vi.fn(async fn => fn({ query: vi.fn(async () => ({ rows: [] })) })), query: vi.fn(), queryOne: vi.fn() });

// Auth off: an analyst, nobody signed in. Auth on: an analyst who is Anna; Anna
// holding a role but no analyst; Piet, who holds nothing here.
const authOff = { me: null, canWrite: true, user: null };
const analystAnna = { me: { principal: { id: ANNA, displayName: 'Anna Voorbeeld', email: 'anna@example.test' }, identity: null }, canWrite: true, user: 'anna@example.test' };
const ownerAnna = { me: { principal: { id: ANNA, displayName: 'Anna Voorbeeld', email: 'anna@example.test' }, identity: { id: ANNA_PERSON } }, canWrite: false, user: 'anna@example.test' };
const piet = { me: { principal: { id: PIET }, identity: null }, canWrite: false, user: 'piet@example.test' };

beforeEach(() => {
  vi.clearAllMocks();
  store.getContext.mockResolvedValue({ id: CTX, displayName: 'Payroll', contextCategory: 'LogicalApplication' });
  store.applicableTemplates.mockResolvedValue([{ id: TPL, name: 'Application intake', currentVersion: 3 }]);
  store.getTemplate.mockResolvedValue({ id: TPL, definition: intake });
  store.holdsRole.mockImplementation(async (_db, _ctx, principalId) => principalId === ANNA);
  store.personName.mockImplementation(async (_db, _col, id) => ({ [ANNA]: 'Anna Voorbeeld', [PIET]: 'Piet Voorbeeld' })[id] ?? null);
  store.openInPlaceRequest.mockResolvedValue(null);
  // The request made is the respondent's: the caller is its recipient when they are the respondent.
  let respondent = null;
  store.insertRequests.mockImplementation(async (_db, rows) => { respondent = rows[0].principalId; return [{ id: REQ, contextId: CTX }]; });
  store.isRecipient.mockImplementation(async (_db, id, principalId) => id === REQ && principalId === respondent);
});

describe('respondentId', () => {
  const mayPick = { pick: true, me: analystAnna.me };
  it('the one named, lower-cased; else the caller; nobody at all is refused', () => {
    expect(start.respondentId(PIET.toUpperCase(), mayPick)).toBe(PIET);
    expect(start.respondentId(undefined, { pick: true, me: { principal: { id: ANNA.toUpperCase() } } })).toBe(ANNA);
    expect(() => start.respondentId(undefined, { pick: true, me: null })).toThrow(/Say who is answering/);
    expect(() => start.respondentId('nope', mayPick)).toThrow(/principalId must be a uuid/);
  });

  it('without the pick, only oneself', () => {
    expect(start.respondentId(ANNA, { pick: false, me: analystAnna.me })).toBe(ANNA);
    expect(() => start.respondentId(PIET, { pick: false, me: analystAnna.me })).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe('startOptions', () => {
  it('an analyst with auth off: may pick, nobody by default, the templates that apply', async () => {
    expect(await start.startOptions(CTX, authOff, { db: db() })).toEqual({
      allowed: true, pickRespondent: true, respondent: null, templates: [{ id: TPL, name: 'Application intake' }],
    });
    expect(store.holdsRole).not.toHaveBeenCalled();
  });

  it('a signed-in analyst defaults to themselves', async () => {
    expect((await start.startOptions(CTX, analystAnna, { db: db() })).respondent)
      .toEqual({ principalId: ANNA, displayName: 'Anna Voorbeeld', email: 'anna@example.test' });
  });

  it('a role holder: themselves, no pick; asked with their person too', async () => {
    expect(await start.startOptions(CTX, ownerAnna, { db: db() })).toMatchObject({ allowed: true, pickRespondent: false, respondent: { principalId: ANNA } });
    expect(store.holdsRole.mock.calls[0].slice(1)).toEqual([CTX, ANNA, ANNA_PERSON]);
  });

  it('anyone else, or nobody signed in without the analyst right: not offered, and no templates read', async () => {
    expect(await start.startOptions(CTX, piet, { db: db() })).toEqual({ allowed: false, pickRespondent: false, respondent: null, templates: [] });
    expect(await start.startOptions(CTX, { me: null, canWrite: false }, { db: db() })).toMatchObject({ allowed: false });
    expect(store.applicableTemplates).not.toHaveBeenCalled();
  });

  it('an unknown context is 404', async () => {
    store.getContext.mockResolvedValue(null);
    await expect(start.startOptions(CTX, authOff, { db: db() })).rejects.toMatchObject({ status: 404 });
  });
});

describe('startSurvey', () => {
  it('auth off: an account must be named', async () => {
    await expect(start.startSurvey(CTX, { templateId: TPL }, authOff, { db: db() })).rejects.toMatchObject({ status: 400, message: /Say who is answering/ });
    expect(store.insertRequests).not.toHaveBeenCalled();
  });

  it('auth off, an account named: one request, in place, at the current version, answered on that account\'s behalf', async () => {
    const r = await start.startSurvey(CTX, { templateId: TPL, principalId: PIET }, { ...authOff, user: 'analyst@example.test' }, { db: db() });
    expect(store.insertRequests.mock.calls[0][1]).toEqual([{
      templateId: TPL, templateVersion: 3, contextId: CTX, principalId: PIET, identityId: null, recipientName: 'Piet Voorbeeld',
      language: null, message: null, dueAt: null, sentBy: 'analyst@example.test', inPlace: true,
    }]);
    expect(r).toEqual({ id: REQ, resumed: false, recipientName: 'Piet Voorbeeld', onBehalf: true });
    expect(store.isRecipient).not.toHaveBeenCalled();
  });

  it('auth on: the signed-in analyst by default, not on anyone\'s behalf', async () => {
    const r = await start.startSurvey(CTX, { templateId: TPL }, analystAnna, { db: db() });
    expect(store.insertRequests.mock.calls[0][1][0]).toMatchObject({ principalId: ANNA, recipientName: 'Anna Voorbeeld' });
    expect(r.onBehalf).toBe(false);
  });

  it('a signed-in analyst for someone else: on their behalf', async () => {
    expect((await start.startSurvey(CTX, { templateId: TPL, principalId: PIET }, analystAnna, { db: db() })).onBehalf).toBe(true);
  });

  it('a role holder for themselves; never for someone else; someone without a role not at all', async () => {
    expect((await start.startSurvey(CTX, { templateId: TPL }, ownerAnna, { db: db() })).onBehalf).toBe(false);
    await expect(start.startSurvey(CTX, { templateId: TPL, principalId: PIET }, ownerAnna, { db: db() })).rejects.toMatchObject({ status: 403, message: /yourself only/ });
    await expect(start.startSurvey(CTX, { templateId: TPL }, piet, { db: db() })).rejects.toMatchObject({ status: 403, message: /holds a role/ });
    expect(store.insertRequests).toHaveBeenCalledTimes(1);
  });

  it('refuses a template for another category or scope, a context that takes no survey, and an unknown account', async () => {
    await expect(start.startSurvey(CTX, { templateId: OTHER_TPL, principalId: PIET }, authOff, { db: db() })).rejects.toMatchObject({ status: 400, message: /cannot be sent about this context/ });
    await expect(start.startSurvey(CTX, { principalId: PIET }, authOff, { db: db() })).rejects.toMatchObject({ status: 400, message: /templateId/ });
    store.getContext.mockResolvedValueOnce({ id: CTX, contextCategory: 'Tag' });
    await expect(start.startSurvey(CTX, { templateId: TPL, principalId: PIET }, authOff, { db: db() })).rejects.toMatchObject({ status: 400 });
    await expect(start.startSurvey(CTX, { templateId: TPL, principalId: ANNA_PERSON }, authOff, { db: db() })).rejects.toMatchObject({ status: 404, message: /account was not found/ });
    expect(store.insertRequests).not.toHaveBeenCalled();
  });

  it('one started and left for the same context, template and account is picked up, not doubled', async () => {
    store.openInPlaceRequest.mockResolvedValue({ id: 'left-1' });
    const r = await start.startSurvey(CTX, { templateId: TPL, principalId: PIET }, authOff, { db: db() });
    expect(store.openInPlaceRequest.mock.calls[0][1]).toEqual({ contextId: CTX, templateId: TPL, principalId: PIET });
    expect(store.insertRequests).not.toHaveBeenCalled();
    expect(r).toMatchObject({ id: 'left-1', resumed: true });
  });
});

describe('answering one done in place — the ordinary submit', () => {
  const request = (over = {}) => ({
    id: REQ, contextId: CTX, contextName: 'Payroll', status: 'sent', principalId: PIET, identityId: null, recipientName: 'Piet Voorbeeld',
    templateName: 'Application intake', definition: intake, language: null, openedAt: '2026-10-25T10:00:00Z', inPlace: true, ...over,
  });
  beforeEach(() => {
    store.isRecipient.mockImplementation(async (_db, _id, principalId) => principalId === ANNA);
    store.getRequest.mockResolvedValue(request());
    store.unitVariants.mockResolvedValue([]);
    interviewStore.insertInterview.mockResolvedValue({ id: 'iv-1' });
    interviewStore.insertClaims.mockResolvedValue(['c1']);
  });

  it('filled in by an analyst with auth off: the respondent\'s claims, recorded on their behalf', async () => {
    await svc.submitSurvey(REQ, { answers: { isOwner: 'yes', criticality: 'B' } }, authOff, { db: db() });
    expect(interviewStore.insertInterview.mock.calls[0][1]).toMatchObject({ principalId: PIET, intervieweeName: 'Piet Voorbeeld', surveyRequestId: REQ });
    expect(interviewStore.insertClaims.mock.calls[0][1]).toEqual({ interviewId: 'iv-1', contextId: CTX, proposedBy: 'respondent' });
    expect(store.markSubmitted.mock.calls[0][2]).toMatchObject({ onBehalf: true });
  });

  it('filled in by the respondent themselves: not on anyone\'s behalf', async () => {
    store.getRequest.mockResolvedValue(request({ principalId: ANNA, recipientName: 'Anna Voorbeeld' }));
    await svc.submitSurvey(REQ, { answers: { isOwner: 'yes', criticality: 'B' } }, ownerAnna, { db: db() });
    expect(store.markSubmitted.mock.calls[0][2]).toMatchObject({ onBehalf: false, user: 'anna@example.test' });
  });
});
