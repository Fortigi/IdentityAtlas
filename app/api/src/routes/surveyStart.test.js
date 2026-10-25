// Route tests for "Do survey" (routes/surveyStart.js): open to any signed-in
// caller with who they are handed to the service (which decides), the status
// each answer gets, and a failure's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../test-utils/routeTestKit.js';

vi.mock('../config/authConfig.js', () => ({ isAuthEnabled: () => true }));
vi.mock('../db/connection.js');
vi.mock('../auth/resolveMe.js', () => ({ resolveMe: vi.fn() }));
vi.mock('../contexts/surveys/start.js', () => ({ startOptions: vi.fn(), startSurvey: vi.fn() }));
process.env.USE_SQL = 'true';

const { default: router } = await import('./surveyStart.js');
const start = await import('../contexts/surveys/start.js');
const { SurveyError } = await import('../contexts/surveys/service.js');
const { resolveMe } = await import('../auth/resolveMe.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const TPL = 'eeeeeeee-0000-4000-8000-000000000001';
const owner = { email: 'anna@example.test', permissions: ['data.read'] };
const app = mountRouterAs(router, () => owner);

beforeEach(() => {
  vi.clearAllMocks();
  resolveMe.mockResolvedValue({ principal: { id: 'p-anna' } });
});

describe('Do survey routes', () => {
  it('GET hands the options for this caller — no analyst right needed', async () => {
    start.startOptions.mockResolvedValue({ allowed: true, pickRespondent: false, respondent: { principalId: 'p-anna' }, templates: [] });
    const r = await request(app).get(`/api/contexts/${CTX}/surveys/start`);
    expect(r.status).toBe(200);
    expect(r.body.respondent).toEqual({ principalId: 'p-anna' });
    expect(start.startOptions.mock.calls[0].slice(0, 2)).toEqual([CTX, { me: { principal: { id: 'p-anna' } }, canWrite: false, user: 'anna@example.test' }]);
  });

  it('POST starts one: 201 with the request id; the body and the caller go to the service', async () => {
    start.startSurvey.mockResolvedValue({ id: 'req-1', resumed: false, recipientName: 'Anna', onBehalf: false });
    const r = await request(app).post(`/api/contexts/${CTX}/surveys/start`).send({ templateId: TPL });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 'req-1', resumed: false, recipientName: 'Anna', onBehalf: false });
    expect(start.startSurvey.mock.calls[0].slice(0, 3)).toEqual([CTX, { templateId: TPL }, { me: { principal: { id: 'p-anna' } }, canWrite: false, user: 'anna@example.test' }]);
  });

  it('a refusal keeps its status; an unexpected failure is a 500 without its message', async () => {
    start.startSurvey.mockRejectedValue(new SurveyError(403, 'You can do this survey for yourself only.'));
    const r = await request(app).post(`/api/contexts/${CTX}/surveys/start`).send({ templateId: TPL, principalId: 'x' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'You can do this survey for yourself only.' });
    start.startOptions.mockRejectedValue(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = await request(app).get(`/api/contexts/${CTX}/surveys/start`);
    expect(g.status).toBe(500);
    expect(g.body).toEqual({ error: 'Reading the survey options failed' });
  });
});
