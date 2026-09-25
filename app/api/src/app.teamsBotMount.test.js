// Where the Teams bot's endpoint sits in the /api middleware chain.
//
// This is a MOUNT-ORDER test, and it exists because nothing else could catch the
// bug it pins. `app.use('/api', authMiddleware, someRouter)` runs authMiddleware
// for every /api request that reaches that line — Express does not look ahead
// into the router to see whether it has a matching route. So a POST to
// /api/messages mounted below the authenticated routers never reaches the bot:
// authMiddleware answers first, tries to validate the Bot Framework's channel
// token against the TENANT's JWKS, and fails with "unable to find a signing key"
// because that token is signed by login.botframework.com.
//
// The route's own tests mount `messagesRouter` standalone, so they pass either
// way. The contract test boots the real app but with auth DISABLED, where
// authMiddleware is a no-op — so it passes either way too. Only the real app
// with auth ENABLED separates the two arrangements, which is what this does.
//
// It shipped broken, and the symptom in production was a Teams message that
// reached the server and produced nothing but a token-validation error.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.hoisted(() => { process.env.USE_SQL = 'true'; });
import request from 'supertest';

// Auth ON, with a JWKS client that behaves like the real one when it meets a
// token it has no key for — which is exactly what a Bot Framework token is.
vi.mock('./config/authConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAuthEnabled: () => true,
  getTenantId: () => 'test-tenant',
  getClientId: () => 'test-client',
  getJwksClient: () => ({
    getSigningKey: (_kid, cb) => cb(new Error("Unable to find a signing key that matches 'botframework-kid'")),
  }),
  getRequiredRoles: () => null,
  getRolePermissions: () => ({ Admin: ['*'] }),
}));

import { createApp } from './app.js';
import { _resetForTest, markSchemaReady } from './startupState.js';

// A synthetic inbound activity, shaped like the channel's.
const ACTIVITY = {
  type: 'message',
  text: 'which groups is Jan in?',
  from: { id: '29:caller' },
  recipient: { id: '28:bot' },
  conversation: { id: 'conv-1' },
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
};

// The header a real activity carries: a JWT from the Bot Framework, NOT from the
// tenant. Three dot-separated segments so it parses as a JWT and reaches the
// signing-key lookup rather than being rejected as malformed.
const CHANNEL_TOKEN = 'Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImJvdGZyYW1ld29yay1raWQifQ.eyJpc3MiOiJodHRwczovL2FwaS5ib3RmcmFtZXdvcmsuY29tIn0.c2ln';

let app;
beforeEach(() => {
  _resetForTest();
  markSchemaReady();
  process.env.FEATURE_TEAMS_BOT = 'true';
  app = createApp();
});
afterEach(() => {
  _resetForTest();
  delete process.env.FEATURE_TEAMS_BOT;
});

const post = () => request(app).post('/api/messages').set('Authorization', CHANNEL_TOKEN).send(ACTIVITY);

describe('POST /api/messages is mounted ahead of authMiddleware', () => {
  it('does not reject an activity for carrying a non-Entra token', async () => {
    // The precise failure this test exists for. authMiddleware answers 401 with
    // this body; the bot's own adapter never does.
    const res = await post();
    expect(res.body?.error).not.toBe('Invalid or expired token');
    expect(res.body?.error).not.toBe('Missing or invalid authorization header');
  });

  it('never runs the tenant JWKS lookup for an inbound activity', async () => {
    // The observable symptom in the logs, asserted directly: a Teams activity
    // must not reach the tenant's signing-key resolver at all.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await post();

    const lines = err.mock.calls.map(c => c.join(' ')).join('\n');
    expect(lines).not.toMatch(/Unable to find a signing key/);
    err.mockRestore();
  });

  it('still refuses an activity — the adapter rejects it, not the tenant', async () => {
    // Mounting it early must not make it open. The request gets past
    // authMiddleware and is then refused by Bot Framework authentication, which
    // is the whole point: two different gates, and only the right one applies.
    const res = await post();
    expect(res.status).not.toBe(200);
  });

  it('answers 404 while the feature is off, rather than 401', async () => {
    // With auth enabled and the bot off, a 401 here would mean authMiddleware is
    // still in front of the route — the flag would be unobservable and the
    // endpoint would announce itself to anything that probed it.
    delete process.env.FEATURE_TEAMS_BOT;
    _resetForTest();
    markSchemaReady();
    const res = await request(createApp()).post('/api/messages').set('Authorization', CHANNEL_TOKEN).send(ACTIVITY);
    expect(res.status).toBe(404);
  });

  it('leaves every other /api route behind authMiddleware', async () => {
    // The mount is early; it must not have moved anything else out from behind
    // the gate. The same token that reaches the bot is rejected here.
    const res = await request(app).get('/api/permissions').set('Authorization', CHANNEL_TOKEN);
    expect(res.status).toBe(401);
  });

  it('keeps the bot-answer deep link behind authMiddleware', async () => {
    // The other half of the router pair is an ordinary signed-in surface and
    // must NOT have been dragged forward with the messages mount.
    const res = await request(app)
      .get('/api/bot-answers/11111111-1111-1111-1111-111111111111')
      .set('Authorization', CHANNEL_TOKEN);
    expect(res.status).toBe(401);
  });
});
