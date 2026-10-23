// Route tests for surveys: which routes need data.write.contexts, who the
// respondent routes hand to the service, and failures → answers. The steps
// themselves are contexts/surveys/*.test.js's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../test-utils/routeTestKit.js';

vi.mock('../middleware/auth.js', () => ({
  requirePermission: (...required) => (req, res, next) => (required.some(p => req.user?.permissions?.includes(p)) ? next() : res.status(403).json({ error: 'Insufficient permissions' })),
}));
vi.mock('../config/authConfig.js', () => ({ isAuthEnabled: () => true }));
vi.mock('../db/connection.js');
vi.mock('../auth/resolveMe.js', () => ({ resolveMe: vi.fn() }));
vi.mock('../contexts/surveys/service.js', async (orig) => {
  const real = await orig();
  const names = ['listTemplates', 'getTemplate', 'createTemplate', 'updateTemplate', 'sendSurvey', 'contextRequests', 'cancelSurvey',
    'mySurveys', 'openSurvey', 'saveDraft', 'submitSurvey', 'searchPeople'];
  return { ...real, ...Object.fromEntries(names.map(n => [n, vi.fn()])) };
});
process.env.USE_SQL = 'true';

const { default: router, callerOf } = await import('./surveys.js');
const svc = await import('../contexts/surveys/service.js');
const { resolveMe } = await import('../auth/resolveMe.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const TPL = 'eeeeeeee-0000-4000-8000-000000000001';
const REQ = 'ffffffff-0000-4000-8000-000000000001';

const analyst = { email: 'analyst@example.test', permissions: ['data.read', 'data.write.contexts'] };
const roleless = { email: 'anna@example.test', permissions: [] };
let caller = analyst;
const app = mountRouterAs(router, () => caller);

beforeEach(() => {
  caller = analyst;
  vi.clearAllMocks();
});

describe('the gate', () => {
  it.each([
    ['get', '/api/surveys/templates'],
    ['get', `/api/surveys/templates/${TPL}`],
    ['post', '/api/surveys/templates'],
    ['put', `/api/surveys/templates/${TPL}`],
    ['post', '/api/surveys/templates/validate'],
    ['post', `/api/contexts/${CTX}/surveys`],
    ['get', `/api/contexts/${CTX}/surveys`],
    ['delete', `/api/surveys/requests/${REQ}`],
  ])('%s %s needs data.write.contexts', async (method, path) => {
    caller = roleless;
    const r = await request(app)[method](path).send({});
    expect(r.status).toBe(403);
  });

  it('the respondent routes are open to a signed-in person; the service decides whose survey it is', async () => {
    caller = roleless;
    resolveMe.mockResolvedValue({ principal: { id: 'p' } });
    svc.mySurveys.mockResolvedValue({ me: null, data: [] });
    svc.openSurvey.mockResolvedValue({ id: REQ });
    svc.saveDraft.mockResolvedValue({ answers: {} });
    svc.submitSurvey.mockResolvedValue({ interviewId: 'iv', claims: 1 });
    expect((await request(app).get('/api/surveys/mine')).status).toBe(200);
    expect((await request(app).get(`/api/surveys/requests/${REQ}`)).status).toBe(200);
    expect((await request(app).put(`/api/surveys/requests/${REQ}/answers`).send({ answers: { a: 'yes' } })).status).toBe(200);
    expect((await request(app).post(`/api/surveys/requests/${REQ}/submit`).send({ answers: {} })).status).toBe(200);
    expect(svc.saveDraft.mock.calls[0].slice(0, 2)).toEqual([REQ, { a: 'yes' }]);
    svc.searchPeople.mockResolvedValue([{ id: 'p' }]);
    expect((await request(app).get(`/api/surveys/requests/${REQ}/people?search=Pi`)).body).toEqual({ data: [{ id: 'p' }] });
    expect(svc.searchPeople.mock.calls[0].slice(0, 2)).toEqual([REQ, 'Pi']);
    expect(svc.submitSurvey.mock.calls[0][2]).toEqual({ me: { principal: { id: 'p' } }, canWrite: false, user: 'anna@example.test' });
  });
});

describe('templates', () => {
  it('validate answers the definition\'s errors', async () => {
    const r = await request(app).post('/api/surveys/templates/validate').send({ definition: { schemaVersion: 2 } });
    expect(r.body).toEqual({ errors: [{ path: 'schemaVersion', message: 'must be 1' }] });
  });

  it('lists all or a context\'s templates; creates with 201; saves; a SurveyError keeps its status and details', async () => {
    svc.listTemplates.mockResolvedValue([{ id: TPL }]);
    expect((await request(app).get(`/api/surveys/templates?contextId=${CTX}&includeArchived=true`)).body).toEqual({ data: [{ id: TPL }] });
    expect(svc.listTemplates.mock.calls[0][0]).toEqual({ contextId: CTX, includeArchived: true });
    svc.createTemplate.mockResolvedValue({ id: TPL });
    expect((await request(app).post('/api/surveys/templates').send({ name: 'X' })).status).toBe(201);
    svc.updateTemplate.mockRejectedValue(new svc.SurveyError(400, 'The questions cannot be saved as they are.', { errors: [{ path: 'title' }] }));
    const r = await request(app).put(`/api/surveys/templates/${TPL}`).send({});
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'The questions cannot be saved as they are.', details: { errors: [{ path: 'title' }] } });
  });

  it('an unexpected failure is a 500 without its message', async () => {
    svc.getTemplate.mockRejectedValue(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await request(app).get(`/api/surveys/templates/${TPL}`);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Reading the survey template failed' });
  });
});

describe('requests', () => {
  it('sends (201), lists, and withdraws (204)', async () => {
    svc.sendSurvey.mockResolvedValue({ sent: [], skipped: [] });
    expect((await request(app).post(`/api/contexts/${CTX}/surveys`).send({ templateId: TPL })).status).toBe(201);
    expect(svc.sendSurvey.mock.calls[0].slice(0, 3)).toEqual([CTX, { templateId: TPL }, 'analyst@example.test']);
    svc.contextRequests.mockResolvedValue([{ id: REQ }]);
    expect((await request(app).get(`/api/contexts/${CTX}/surveys`)).body).toEqual({ data: [{ id: REQ }] });
    svc.cancelSurvey.mockResolvedValue(undefined);
    expect((await request(app).delete(`/api/surveys/requests/${REQ}`)).status).toBe(204);
  });
});

describe('callerOf', () => {
  it('a read token is nobody; anyone else is who resolveMe says, with their write permission', async () => {
    resolveMe.mockResolvedValue({ principal: { id: 'p' } });
    expect(await callerOf({ readToken: { id: 1 }, user: analyst })).toMatchObject({ me: null });
    expect(resolveMe).not.toHaveBeenCalled();
    expect(await callerOf({ user: { ...analyst, permissions: new Set(analyst.permissions) } })).toMatchObject({ me: { principal: { id: 'p' } }, canWrite: true });
  });
});
