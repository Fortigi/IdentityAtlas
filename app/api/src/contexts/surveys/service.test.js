// The steps behind the survey routes, with the SQL module mocked: what is sent
// to whom, who may open and answer, and what a submit writes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', async (orig) => {
  const real = await orig();
  const fns = Object.fromEntries(Object.entries(real).filter(([, v]) => typeof v === 'function').map(([k]) => [k, vi.fn()]));
  return { ...real, ...fns };
});
vi.mock('../interviews/store.js', async (orig) => ({ ...(await orig()), insertInterview: vi.fn(), insertClaims: vi.fn() }));

const store = await import('./store.js');
const interviewStore = await import('../interviews/store.js');
const svc = await import('./service.js');
const { SEED_TEMPLATES } = await import('./seedTemplates.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const CHILD = 'dddddddd-0000-4000-8000-000000000002';
const BARE = 'dddddddd-0000-4000-8000-000000000003';
const TPL = 'eeeeeeee-0000-4000-8000-000000000001';
const REQ = 'ffffffff-0000-4000-8000-000000000001';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const KIM = 'bbbbbbbb-0000-4000-8000-000000000001';

const intake = SEED_TEMPLATES.find(t => t.key === 'application-intake').definition;
const roster = SEED_TEMPLATES.find(t => t.key === 'unit-roster').definition;

// A db whose transaction hands the callback a client; queries in it are recorded.
function fakeDb() {
  const client = { query: vi.fn(async () => ({ rows: [] })) };
  return { client, tx: vi.fn(async fn => fn(client)), query: vi.fn(), queryOne: vi.fn() };
}

beforeEach(() => vi.clearAllMocks());

describe('helpers', () => {
  it('keyFrom makes a key of a name', () => {
    expect(svc.keyFrom('  Klantcheck — Café 2026! ')).toBe('klantcheck-cafe-2026');
    expect(svc.keyFrom('!!!')).toBe('survey');
  });

  it('parseTemplateFields: a create needs a name and a category; an update takes only what is given', () => {
    expect(() => svc.parseTemplateFields({ contextCategory: 'LogicalApplication' }, { create: true })).toThrow(/name/);
    expect(() => svc.parseTemplateFields({ name: 'X', contextCategory: 'Tag' }, { create: true })).toThrow(/contextCategory/);
    expect(() => svc.parseTemplateFields({ name: 'X', contextCategory: 'LogicalApplication', key: 'Bad Key' }, { create: true })).toThrow(/key/);
    expect(() => svc.parseTemplateFields({ scopeRootContextId: 'x' })).toThrow(/uuid/);
    expect(svc.parseTemplateFields({ name: ' Intake ', contextCategory: 'LogicalApplication', description: '' }, { create: true }))
      .toEqual({ name: 'Intake', contextCategory: 'LogicalApplication', description: null });
    expect(svc.parseTemplateFields({ scopeRootContextId: CTX.toUpperCase() })).toEqual({ scopeRootContextId: CTX });
    expect(svc.parseTemplateFields({ scopeRootContextId: null })).toEqual({ scopeRootContextId: null });
  });

  it('parseSend: a template, and a recipient or the Accountable; a real due date', () => {
    expect(svc.parseSend({ templateId: TPL, recipient: { principalId: ANNA }, dueAt: '2026-11-01', message: ' Graag ' }))
      .toEqual({ templateId: TPL, recipient: { col: 'principalId', id: ANNA }, dueAt: '2026-11-01', message: 'Graag', includeSubContexts: false, language: null });
    expect(svc.parseSend({ templateId: TPL, toAccountable: true }).recipient).toBeNull();
    expect(() => svc.parseSend({ templateId: TPL })).toThrow(/Say who receives it/);
    expect(() => svc.parseSend({ templateId: 'x', toAccountable: true })).toThrow(/templateId must be a uuid/);
    expect(() => svc.parseSend({ templateId: TPL, recipient: { principalId: ANNA, identityId: PIET } })).toThrow(/not both/);
    expect(() => svc.parseSend({ templateId: TPL, toAccountable: true, dueAt: 'next week' })).toThrow(/dueAt/);
  });

  it('rowContexts: the unit itself when it holds people, else its people variant, else its accounts; resources from every resource variant', () => {
    const v = [{ id: 'self', targetType: 'Resource', self: true }, { id: 'acc', targetType: 'Principal' }, { id: 'ppl', targetType: 'Identity' }];
    expect(svc.rowContexts('members', v)).toEqual(['ppl']);
    expect(svc.rowContexts('members', v.filter(x => x.id !== 'ppl'))).toEqual(['acc']);
    expect(svc.rowContexts('members', [{ id: 'self', targetType: 'Principal', self: true }, { id: 'ppl', targetType: 'Identity' }])).toEqual(['self']);
    expect(svc.rowContexts('resources', v)).toEqual(['self']);
    expect(svc.rowContexts('children', v)).toEqual(['self']);
  });

  it('toRow keeps the display name among the columns and lower-cases the id', () => {
    expect(svc.toRow({ id: KIM.toUpperCase(), kind: 'Principal', displayName: 'Kim', jobTitle: 'Analyst' }))
      .toEqual({ id: KIM, kind: 'Principal', displayName: 'Kim', columns: { displayName: 'Kim', jobTitle: 'Analyst' } });
    expect(svc.toRow({ id: KIM, kind: 'Principal', displayName: null }).displayName).toBe(KIM);
  });
});

describe('templates', () => {
  it('createTemplate refuses a definition with errors and lists them', async () => {
    const db = fakeDb();
    await expect(svc.createTemplate({ name: 'X', contextCategory: 'LogicalApplication', definition: { schemaVersion: 1 } }, 'me', { db }))
      .rejects.toMatchObject({ status: 400, details: { errors: [expect.objectContaining({ path: 'languages' })] } });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('createTemplate stores version 1 under a free key in one transaction', async () => {
    const db = fakeDb();
    store.keyExists.mockImplementation(async (_db, k) => k === 'intake');
    store.insertTemplate.mockResolvedValue(TPL);
    store.getTemplate.mockResolvedValue({ id: TPL, definition: intake });
    store.listVersions.mockResolvedValue([{ version: 1 }]);
    const t = await svc.createTemplate({ name: 'Intake', contextCategory: 'LogicalApplication', definition: intake }, 'me', { db });
    expect(store.insertTemplate.mock.calls[0][1]).toMatchObject({ key: 'intake-2', name: 'Intake', builtIn: false, createdBy: 'me' });
    expect(store.insertVersion.mock.calls[0].slice(1)).toEqual([TPL, 1, intake, 'me']);
    expect(t.versions).toEqual([{ version: 1 }]);
  });

  it('createTemplate refuses a scope root of another category', async () => {
    store.getContext.mockResolvedValue({ id: CTX, displayName: 'Finance', contextCategory: 'OrganizationalUnit' });
    await expect(svc.createTemplate({ name: 'X', contextCategory: 'LogicalApplication', scopeRootContextId: CTX, definition: intake }, 'me', { db: fakeDb() }))
      .rejects.toMatchObject({ status: 400, message: /"Finance" is not one/ });
    store.getContext.mockResolvedValue(null);
    await expect(svc.createTemplate({ name: 'X', contextCategory: 'LogicalApplication', scopeRootContextId: CTX, definition: intake }, 'me', { db: fakeDb() }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('updateTemplate: changed questions are the next version; unchanged ones and a rename are not', async () => {
    store.getTemplate.mockResolvedValue({ id: TPL, currentVersion: 3, contextCategory: 'LogicalApplication', definition: intake });
    store.listVersions.mockResolvedValue([]);
    await svc.updateTemplate(TPL, { name: 'Renamed', definition: intake }, 'me', { db: fakeDb() });
    expect(store.insertVersion).not.toHaveBeenCalled();
    expect(store.updateTemplate.mock.calls[0][2]).toEqual({ name: 'Renamed' });

    const changed = { ...intake, title: 'New title' };
    await svc.updateTemplate(TPL, { definition: changed, archived: true }, 'me', { db: fakeDb() });
    expect(store.insertVersion.mock.calls[0].slice(1)).toEqual([TPL, 4, changed, 'me']);
    expect(store.updateTemplate.mock.calls[1][2]).toMatchObject({ currentVersion: 4, archivedAt: expect.any(String) });
  });

  it('getTemplate is 404 when there is none; listTemplates with a context asks for the applicable ones', async () => {
    store.getTemplate.mockResolvedValue(null);
    await expect(svc.getTemplate(TPL, { db: fakeDb() })).rejects.toMatchObject({ status: 404 });
    store.getContext.mockResolvedValue({ id: CTX });
    store.applicableTemplates.mockResolvedValue(['t']);
    expect(await svc.listTemplates({ contextId: CTX }, { db: fakeDb() })).toEqual(['t']);
    store.getContext.mockResolvedValue(null);
    await expect(svc.listTemplates({ contextId: CTX }, { db: fakeDb() })).rejects.toMatchObject({ status: 404 });
    store.listTemplates.mockResolvedValue(['all']);
    expect(await svc.listTemplates({}, { db: fakeDb() })).toEqual(['all']);
  });
});

describe('sendSurvey', () => {
  beforeEach(() => {
    store.getContext.mockResolvedValue({ id: CTX, displayName: 'Payroll', contextCategory: 'LogicalApplication' });
    store.applicableTemplates.mockResolvedValue([{ id: TPL, currentVersion: 2 }]);
    store.getTemplate.mockResolvedValue({ id: TPL, definition: intake });
    store.insertRequests.mockImplementation(async (_db, rows) => rows.map((r, i) => ({ id: `req-${i}`, contextId: r.contextId })));
  });

  it('to a named person: one request at the template\'s current version', async () => {
    store.personName.mockResolvedValue('Anna Voorbeeld');
    store.accountablesOf.mockResolvedValue(new Map());
    const r = await svc.sendSurvey(CTX, { templateId: TPL, recipient: { principalId: ANNA }, dueAt: '2026-11-01' }, 'analyst', { db: fakeDb() });
    expect(store.insertRequests.mock.calls[0][1]).toEqual([expect.objectContaining({
      templateId: TPL, templateVersion: 2, contextId: CTX, principalId: ANNA, identityId: null, recipientName: 'Anna Voorbeeld', dueAt: '2026-11-01', sentBy: 'analyst',
    })]);
    expect(r).toEqual({ sent: [{ id: 'req-0', contextId: CTX, contextName: 'Payroll', recipientName: 'Anna Voorbeeld' }], skipped: [] });
  });

  it('down the tree: each unit\'s Accountable; a unit without one is skipped and named', async () => {
    store.contextTree.mockResolvedValue([{ id: CTX, displayName: 'Payroll' }, { id: CHILD, displayName: 'Payroll NL' }, { id: BARE, displayName: 'Payroll BE' }]);
    store.accountablesOf.mockResolvedValue(new Map([
      [CTX, { principalId: ANNA, identityId: null, displayName: 'Anna' }],
      [CHILD, { principalId: null, identityId: PIET, displayName: 'Piet' }],
    ]));
    const r = await svc.sendSurvey(CTX, { templateId: TPL, toAccountable: true, includeSubContexts: true }, 'analyst', { db: fakeDb() });
    expect(store.insertRequests.mock.calls[0][1].map(x => [x.contextId, x.principalId, x.identityId, x.recipientName]))
      .toEqual([[CTX, ANNA, null, 'Anna'], [CHILD, null, PIET, 'Piet']]);
    expect(r.skipped).toEqual([{ contextId: BARE, contextName: 'Payroll BE', reason: 'has no Accountable' }]);
  });

  it('refuses a context that is not a unit or application, a template that does not apply, a language it lacks, and an unknown recipient', async () => {
    store.getContext.mockResolvedValueOnce({ id: CTX, contextCategory: 'Tag' });
    await expect(svc.sendSurvey(CTX, { templateId: TPL, toAccountable: true }, 'a', { db: fakeDb() })).rejects.toMatchObject({ status: 400, message: /organizational unit or a logical application/ });
    store.applicableTemplates.mockResolvedValueOnce([]);
    await expect(svc.sendSurvey(CTX, { templateId: TPL, toAccountable: true }, 'a', { db: fakeDb() })).rejects.toMatchObject({ status: 400, message: /cannot be sent about this context/ });
    await expect(svc.sendSurvey(CTX, { templateId: TPL, toAccountable: true, language: 'de' }, 'a', { db: fakeDb() })).rejects.toMatchObject({ status: 400, message: /en, nl/ });
    store.personName.mockResolvedValue(null);
    await expect(svc.sendSurvey(CTX, { templateId: TPL, recipient: { identityId: PIET } }, 'a', { db: fakeDb() })).rejects.toMatchObject({ status: 404 });
    store.getContext.mockResolvedValueOnce(null);
    await expect(svc.sendSurvey(CTX, { templateId: TPL, toAccountable: true }, 'a', { db: fakeDb() })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a tree larger than one send may cover', async () => {
    store.contextTree.mockResolvedValue(Array.from({ length: svc.MAX_TREE + 1 }, (_, i) => ({ id: `c${i}` })));
    await expect(svc.sendSurvey(CTX, { templateId: TPL, toAccountable: true, includeSubContexts: true }, 'a', { db: fakeDb() }))
      .rejects.toMatchObject({ status: 400, message: /at most 500/ });
  });
});

describe('answering', () => {
  const request = (over = {}) => ({
    id: REQ, contextId: CTX, contextName: 'Payroll', status: 'sent', principalId: ANNA, identityId: null, recipientName: 'Anna Voorbeeld',
    templateName: 'Application intake', definition: intake, language: null, openedAt: null, contextDescription: 'Pays', contextAttributes: { criticality: 'B' }, ...over,
  });
  const recipient = { me: { principal: { id: ANNA }, identity: null }, canWrite: false, user: 'anna@example.test' };
  const analyst = { me: null, canWrite: true, user: 'analyst@example.test' };
  const stranger = { me: { principal: { id: PIET }, identity: null }, canWrite: false, user: 'piet@example.test' };

  beforeEach(() => {
    store.getRequest.mockResolvedValue(request());
    store.isRecipient.mockImplementation(async (_db, _id, principalId) => principalId === ANNA);
    store.unitVariants.mockResolvedValue([]);
  });

  it('mySurveys: nothing without a mapping; the person\'s requests with who they are', async () => {
    expect(await svc.mySurveys(null, { db: fakeDb() })).toEqual({ me: null, data: [] });
    store.requestsFor.mockResolvedValue(['r']);
    expect(await svc.mySurveys({ principal: { id: ANNA, displayName: 'Anna (adm)' }, identity: { id: PIET, displayName: 'Anna' } }, { db: fakeDb() }))
      .toEqual({ me: { principalId: ANNA, identityId: PIET, displayName: 'Anna' }, data: ['r'] });
    expect(store.requestsFor.mock.calls[0].slice(1)).toEqual([ANNA, PIET]);
  });

  it('the recipient opens it (marked opened); an analyst opens it without marking; anyone else is refused', async () => {
    const r = await svc.openSurvey(REQ, recipient, { db: fakeDb() });
    expect(store.markOpened).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ asRecipient: true, contextValues: { description: 'Pays', criticality: 'B' }, rows: {} });
    expect(r.contextAttributes).toBeUndefined();
    await svc.openSurvey(REQ, analyst, { db: fakeDb() });
    expect(store.markOpened).toHaveBeenCalledTimes(1);
    await expect(svc.openSurvey(REQ, stranger, { db: fakeDb() })).rejects.toMatchObject({ status: 403 });
    store.getRequest.mockResolvedValue(null);
    await expect(svc.openSurvey(REQ, analyst, { db: fakeDb() })).rejects.toMatchObject({ status: 404 });
  });

  it('loads the rows of per-row questions once per source, sorted by name', async () => {
    store.getRequest.mockResolvedValue(request({ definition: roster }));
    store.unitVariants.mockResolvedValue([{ id: CTX, targetType: 'Identity', self: true }]);
    store.rowsFrom.mockResolvedValue([{ id: KIM, kind: 'Identity', displayName: 'Zoë' }, { id: PIET, kind: 'Identity', displayName: 'Arjen' }]);
    const r = await svc.openSurvey(REQ, analyst, { db: fakeDb() });
    expect(store.rowsFrom).toHaveBeenCalledTimes(1);
    expect(store.rowsFrom.mock.calls[0][2]).toEqual([CTX]);
    expect(Object.keys(r.rows)).toEqual(['worksHere', 'role', 'responsibleFor']);
    expect(r.rows.worksHere.map(x => x.displayName)).toEqual(['Arjen', 'Zoë']);
  });

  it('saveDraft keeps valid answers and refuses malformed ones; an answered or withdrawn survey is closed', async () => {
    expect(await svc.saveDraft(REQ, { isOwner: 'yes', nis2: 'maybe' }, recipient, { db: fakeDb() }).catch(e => e)).toMatchObject({ status: 400, details: { errors: [{ question: 'nis2' }] } });
    expect(await svc.saveDraft(REQ, { isOwner: 'yes' }, recipient, { db: fakeDb() })).toEqual({ answers: { isOwner: 'yes' } });
    expect(store.saveAnswers.mock.calls[0].slice(1)).toEqual([REQ, { isOwner: 'yes' }]);
    store.getRequest.mockResolvedValue(request({ status: 'submitted' }));
    await expect(svc.saveDraft(REQ, {}, recipient, { db: fakeDb() })).rejects.toMatchObject({ status: 409, message: /already been answered/ });
    store.getRequest.mockResolvedValue(request({ status: 'cancelled' }));
    await expect(svc.saveDraft(REQ, {}, recipient, { db: fakeDb() })).rejects.toMatchObject({ status: 409, message: /withdrawn/ });
  });

  it('submit refuses incomplete answers', async () => {
    await expect(svc.submitSurvey(REQ, { answers: { nis2: 'yes' } }, recipient, { db: fakeDb() }))
      .rejects.toMatchObject({ status: 400, details: { errors: expect.arrayContaining([{ question: 'isOwner', message: 'needs an answer' }]) } });
  });

  it('submit by the recipient: one interview from the survey, its claims proposed by the respondent, the request answered', async () => {
    const db = fakeDb();
    interviewStore.insertInterview.mockResolvedValue({ id: 'iv-1' });
    interviewStore.insertClaims.mockResolvedValue(['c1', 'c2']);
    const r = await svc.submitSurvey(REQ, { answers: { isOwner: 'yes', criticality: 'A' }, language: 'nl' }, recipient, { db });
    expect(r).toEqual({ interviewId: 'iv-1', claims: 2 });
    const iv = interviewStore.insertInterview.mock.calls[0][1];
    expect(iv).toMatchObject({ contextId: CTX, principalId: ANNA, intervieweeName: 'Anna Voorbeeld', fileName: 'Application intake (survey)', language: 'nl', extractionStatus: 'done', surveyRequestId: REQ, createdBy: 'anna@example.test' });
    expect(iv.transcript).toMatch(/^Vragenlijst: Intake applicatie: Payroll/);
    const [, meta, claims] = interviewStore.insertClaims.mock.calls[0];
    expect(meta).toEqual({ interviewId: 'iv-1', contextId: CTX, proposedBy: 'respondent' });
    expect(claims.map(c => c.surveyQuestionId)).toEqual(['isOwner', 'criticality']);
    expect(store.markSubmitted.mock.calls[0][2]).toEqual({ answers: { isOwner: 'yes', criticality: 'A' }, interviewId: 'iv-1', user: 'anna@example.test', onBehalf: false, language: 'nl' });
    expect(store.getRequest.mock.calls.at(-1)[2]).toEqual({ lock: true });
  });

  it('submit by an analyst is on the recipient\'s behalf, in the request\'s language unless another of the template\'s is asked', async () => {
    store.getRequest.mockResolvedValue(request({ language: 'en' }));
    interviewStore.insertInterview.mockResolvedValue({ id: 'iv-2' });
    interviewStore.insertClaims.mockResolvedValue([]);
    await svc.submitSurvey(REQ, { answers: { isOwner: 'yes', criticality: 'A' }, language: 'de' }, analyst, { db: fakeDb() });
    expect(store.markSubmitted.mock.calls[0][2]).toMatchObject({ onBehalf: true, language: 'en', user: 'analyst@example.test' });
  });

  it('submit re-reads the request under a lock: one answered meanwhile is refused', async () => {
    store.getRequest.mockResolvedValueOnce(request()).mockResolvedValueOnce(request({ status: 'submitted' }));
    await expect(svc.submitSurvey(REQ, { answers: { isOwner: 'yes', criticality: 'A' } }, recipient, { db: fakeDb() })).rejects.toMatchObject({ status: 409 });
    expect(interviewStore.insertInterview).not.toHaveBeenCalled();
  });

  it('searchPeople: only for whoever may answer; nothing for a term under two characters; the e-mail as userPrincipalName', async () => {
    store.searchPeople.mockResolvedValue([{ id: PIET, displayName: 'Piet', email: 'piet@example.test' }]);
    await expect(svc.searchPeople(REQ, 'Piet', stranger, { db: fakeDb() })).rejects.toMatchObject({ status: 403 });
    expect(await svc.searchPeople(REQ, ' P ', recipient, { db: fakeDb() })).toEqual([]);
    expect(store.searchPeople).not.toHaveBeenCalled();
    expect(await svc.searchPeople(REQ, '  Pi ', recipient, { db: fakeDb() })).toEqual([{ id: PIET, displayName: 'Piet', email: 'piet@example.test', userPrincipalName: 'piet@example.test' }]);
    expect(store.searchPeople.mock.calls[0][1]).toBe('Pi');
  });

  it('cancelSurvey is 404 when there is nothing unanswered to withdraw', async () => {
    store.cancelRequest.mockResolvedValue(0);
    await expect(svc.cancelSurvey(REQ, { db: fakeDb() })).rejects.toMatchObject({ status: 404 });
    store.cancelRequest.mockResolvedValue(1);
    await expect(svc.cancelSurvey(REQ, { db: fakeDb() })).resolves.toBeUndefined();
  });

  it('contextRequests checks the id', async () => {
    await expect(svc.contextRequests('x', { db: fakeDb() })).rejects.toMatchObject({ status: 400 });
    store.listContextRequests.mockResolvedValue(['r']);
    expect(await svc.contextRequests(CTX, { db: fakeDb() })).toEqual(['r']);
  });
});
