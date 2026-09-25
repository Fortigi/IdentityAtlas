import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db/connection.js');
// requirePermission is a NO-OP while auth is disabled, which is the default in
// unit tests — without this the permission assertions below would pass on a
// route that had no gate at all.
vi.mock('../config/authConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAuthEnabled: () => true,
}));
vi.mock('../teamsbot/log.js', () => ({ findAnswerForCaller: vi.fn() }));
vi.mock('../nlreports/service.js', () => ({ runSpec: vi.fn() }));

const botRun = vi.fn();
vi.mock('../teamsbot/handler.js', () => ({ IdentityAtlasBot: class { run(...args) { return botRun(...args); } } }));

import { findAnswerForCaller } from '../teamsbot/log.js';
import { runSpec } from '../nlreports/service.js';
import { messagesRouter, botAnswersRouter, __reset } from './teamsBot.js';

const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_OID = '99999999-9999-9999-9999-999999999999';
const ANSWER_ID = '11111111-1111-1111-1111-111111111111';

/** The signed-in surface: a caller with the permissions a test gives them. */
function signedInApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', botAnswersRouter);
  return app;
}

function publicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', messagesRouter);
  return app;
}

const asker = { oid: OID, permissions: new Set(['data.read.reports']) };

beforeEach(() => {
  vi.clearAllMocks();
  __reset();
  process.env.FEATURE_TEAMS_BOT = 'true';
});

afterEach(() => {
  delete process.env.FEATURE_TEAMS_BOT;
});

describe('POST /api/messages — the feature flag', () => {
  it('does not exist while the bot is switched off', async () => {
    // 404, not 401: an endpoint that answers "unauthorised" tells a scanner
    // there is a bot here to come back for.
    delete process.env.FEATURE_TEAMS_BOT;
    const res = await request(publicApp()).post('/api/messages').send({ type: 'message', text: 'hi' });
    expect(res.status).toBe(404);
  });

  it('is off unless the flag says exactly "true"', async () => {
    for (const value of ['false', 'TRUE', '1', 'yes', '']) {
      process.env.FEATURE_TEAMS_BOT = value;
      const res = await request(publicApp()).post('/api/messages').send({ type: 'message' });
      expect(res.status, `FEATURE_TEAMS_BOT=${value}`).toBe(404);
    }
  });

  it('never lets an activity with a bogus Bot Framework token reach the bot', async () => {
    // With the flag on the request reaches the adapter, which authenticates it.
    // What matters is not which error comes back but that the turn handler —
    // and therefore the report pipeline and the database — is never entered.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TEAMS_BOT_APP_ID = '00000000-1111-2222-3333-444444444444';
    process.env.TEAMS_BOT_APP_PASSWORD = 'not-the-real-secret';
    __reset();

    const res = await request(publicApp())
      .post('/api/messages')
      .set('Authorization', 'Bearer not-a-real-bot-framework-token')
      .send({ type: 'message', text: 'hi', from: { id: '29:x' }, conversation: { id: 'c1' }, serviceUrl: 'https://smba.trafficmanager.net/emea/' });

    expect(res.status).not.toBe(200);
    expect(botRun).not.toHaveBeenCalled();

    delete process.env.TEAMS_BOT_APP_ID;
    delete process.env.TEAMS_BOT_APP_PASSWORD;
    err.mockRestore();
  });
});

describe('GET /api/bot-answers/:id', () => {
  it('runs the stored definition and answers with the rows', async () => {
    findAnswerForCaller.mockResolvedValue({ id: ANSWER_ID, question: 'my direct reports', definition: { entity: 'user' } });
    runSpec.mockResolvedValue({ ok: true, rows: [{ displayName: 'Jan' }], columns: [{ key: 'displayName', label: 'Name' }], explanation: 'x' });

    const res = await request(signedInApp(asker)).get(`/api/bot-answers/${ANSWER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.question).toBe('my direct reports');
    expect(res.body.rows).toEqual([{ displayName: 'Jan' }]);
    expect(runSpec).toHaveBeenCalledWith({ entity: 'user' });
  });

  it('serves the answer only to the caller who asked the question', async () => {
    findAnswerForCaller.mockResolvedValue(null);

    const res = await request(signedInApp({ ...asker, oid: OTHER_OID })).get(`/api/bot-answers/${ANSWER_ID}`);

    expect(res.status).toBe(404);
    expect(findAnswerForCaller).toHaveBeenCalledWith(ANSWER_ID, OTHER_OID);
    expect(runSpec).not.toHaveBeenCalled();
  });

  it('answers 404 — not 403 — for someone else\'s answer, so a forwarded link learns nothing', async () => {
    findAnswerForCaller.mockResolvedValue(null);
    const res = await request(signedInApp({ ...asker, oid: OTHER_OID })).get(`/api/bot-answers/${ANSWER_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error).not.toMatch(/permission|forbidden|belongs/i);
  });

  it('refuses a caller with no oid rather than looking up undefined', async () => {
    // A read API key (fgr_) has permissions but no oid. It must not be able to
    // enumerate bot answers.
    const res = await request(signedInApp({ permissions: new Set(['data.read.reports']) })).get(`/api/bot-answers/${ANSWER_ID}`);

    expect(res.status).toBe(403);
    expect(findAnswerForCaller).not.toHaveBeenCalled();
  });

  it('refuses a signed-in caller without the asking permission', async () => {
    const res = await request(signedInApp({ oid: OID, permissions: new Set(['data.read', 'data.export.ui']) }))
      .get(`/api/bot-answers/${ANSWER_ID}`);

    expect(res.status).toBe(403);
    expect(findAnswerForCaller).not.toHaveBeenCalled();
  });

  it('checks the permission BEFORE the feature flag, so the flag never leaks', async () => {
    // With the bot off, a caller without permission must still get 403: the
    // order decides whether an outsider can discover which installs run a bot.
    delete process.env.FEATURE_TEAMS_BOT;
    const denied = await request(signedInApp({ oid: OID, permissions: new Set(['data.read']) })).get(`/api/bot-answers/${ANSWER_ID}`);
    expect(denied.status).toBe(403);

    const allowed = await request(signedInApp(asker)).get(`/api/bot-answers/${ANSWER_ID}`);
    expect(allowed.status).toBe(404);
  });

  it('says the report can no longer be run when the definition stopped validating', async () => {
    // A definition is re-validated on every run, so a catalog change can make a
    // stored one invalid. That is a 400 with a reason, not a 500.
    findAnswerForCaller.mockResolvedValue({ id: ANSWER_ID, question: 'q', definition: { entity: 'gone' } });
    runSpec.mockResolvedValue({ ok: false, errors: ['unknown entity "gone"'] });

    const res = await request(signedInApp(asker)).get(`/api/bot-answers/${ANSWER_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['unknown entity "gone"']);
  });

  it('never puts the underlying error in the response body', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    findAnswerForCaller.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await request(signedInApp(asker)).get(`/api/bot-answers/${ANSWER_ID}`);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('connection terminated');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
