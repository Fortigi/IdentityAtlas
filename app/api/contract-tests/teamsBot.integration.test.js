// Teams bot — end-to-end, from a synthetic Bot Framework activity to a row in
// the conversation log.
//
// EVERYTHING here is real except the model: the Express app, the adapter, the
// caller lookup, `runSpec`'s compiled SQL, the PostgreSQL container it runs
// against, the card, and the log write. Only `interpret()` is replaced, with a
// fixed report definition — the generator needs a 2.7 GB llama.cpp container and
// tens of seconds per answer, and what it produces is measured by its own
// evaluation harness (tools/nl-reports/eval.mjs), not here.
//
// That boundary is deliberate. The interesting failures in this feature are not
// "did the model understand" — they are "did the caller's @me become the right
// uuid", "did that uuid reach the SQL", and "was the answer recorded". None of
// those involve the model, and all of them need a real database.
//
// Bot Framework authentication: the adapter is constructed with NO app id, which
// is the documented anonymous/emulator mode. The activity is therefore accepted
// without a channel token — that is what makes it postable from a test. The
// route test (src/routes/teamsBot.test.js) covers the configured case, where an
// activity with a bogus token never reaches the handler.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

const CALLER_OID = randomUUID();
const REPORT_OID = randomUUID();
const STRANGER_OID = randomUUID();

// The one mocked seam. `interpret` answers with a definition that asks for
// "accounts whose manager is @me" — the shape the caller-substitution exists
// for. Everything downstream of it is real.
vi.mock('../src/nlreports/service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    interpret: vi.fn(async () => ({
      kind: 'report',
      timing: { totalMs: 1234 },
      spec: {
        entity: 'user',
        match: 'all',
        conditions: [{
          type: 'relation', relation: 'manager', quantifier: 'some', match: 'all',
          conditions: [{ type: 'field', field: 'id', op: 'eq', value: '@me' }],
        }],
        columns: ['displayName', 'email'],
        limit: 1000,
      },
    })),
  };
});

// Teams SSO cannot happen in a test, so the token exchange is replaced by the
// caller it would have produced. The oid it returns is the ONLY thing the rest
// of the flow is told about who is asking.
vi.mock('../src/teamsbot/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  callerFromTurn: vi.fn(async () => ({ ok: true, oid: CALLER_OID })),
}));

let agent;
let pool;

/** A synthetic Teams message activity, as the channel would post it. */
const activity = (text, conversationId = 'conv-integration') => ({
  type: 'message',
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  channelId: 'msteams',
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  from: { id: '29:caller', name: 'Wim van den Heijkant', aadObjectId: STRANGER_OID },
  recipient: { id: '28:bot', name: 'Identity Atlas' },
  conversation: { conversationType: 'personal', id: conversationId },
  text,
});

const post = (body) => agent.post('/api/messages').set('Content-Type', 'application/json').send(body);

beforeAll(async () => {
  process.env.FEATURE_TEAMS_BOT = 'true';
  // No TEAMS_BOT_APP_ID: anonymous adapter, so the activity is accepted.
  delete process.env.TEAMS_BOT_APP_ID;
  delete process.env.TEAMS_BOT_APP_PASSWORD;

  ({ agent, pool } = await bootContractApp());

  const systemId = (await pool.query(
    `INSERT INTO "Systems" ("name", "systemType") VALUES ('TeamsBotIT', 'EntraID') RETURNING "id"`,
  )).rows[0].id;

  // The caller, one person reporting to them, and one who does not.
  await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "accountEnabled", "managerId")
     VALUES ($1, $4, 'Wim van den Heijkant', 'wim@example.com', 'User', true, NULL),
            ($2, $4, 'Jan de Vries',         'jan@example.com', 'User', true, $1),
            ($3, $4, 'Someone Else',         'else@example.com','User', true, NULL)`,
    [CALLER_OID, REPORT_OID, STRANGER_OID, systemId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM "BotConversations" WHERE "callerOid" = $1`, [CALLER_OID]);
  await pool.query(`DELETE FROM "Principals" WHERE "id" = ANY($1)`, [[CALLER_OID, REPORT_OID, STRANGER_OID]]);
  await pool.query(`DELETE FROM "Systems" WHERE "name" = 'TeamsBotIT'`);
  await pool.end();
  delete process.env.USE_SQL;
  delete process.env.FEATURE_TEAMS_BOT;
});

/** The conversation log row for a question, once the turn has finished. */
async function logRow(conversationId) {
  const { rows } = await pool.query(
    `SELECT * FROM "BotConversations" WHERE "conversationId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

describe('POST /api/messages — a question, end to end', () => {
  it('accepts the activity', async () => {
    const res = await post(activity('which of my direct reports are there?', 'conv-happy'));
    expect(res.status).toBeLessThan(300);
  });

  it('answered it, and recorded the measurements', async () => {
    const row = await logRow('conv-happy');

    expect(row).not.toBeNull();
    expect(row.outcome).toBe('answered');
    expect(row.callerOid).toBe(CALLER_OID);
    expect(row.callerPrincipalId).toBe(CALLER_OID);
    expect(row.question).toBe('which of my direct reports are there?');
    expect(row.language).toBe('en');
    expect(row.modelMs).toBe(1234);
    expect(row.queryMs).toBeGreaterThanOrEqual(0);
    expect(row.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('resolved "my" to the CALLER, not to the identity the activity claimed', async () => {
    // The activity's `from.aadObjectId` is a different person entirely. If the
    // bot read the body instead of the token, the stored definition would carry
    // that uuid — and the answer would be about someone else's org.
    const row = await logRow('conv-happy');
    const value = row.definition.conditions[0].conditions[0].value;

    expect(value).toBe(CALLER_OID);
    expect(value).not.toBe(STRANGER_OID);
    expect(JSON.stringify(row.definition)).not.toContain('@me');
  });

  it('found exactly the caller\'s own direct report — the query really ran', async () => {
    // One row, and it is Jan: the third seeded person has no manager, so a
    // definition that lost its condition would return two.
    const row = await logRow('conv-happy');
    expect(row.rowCount).toBe(1);
    expect(row.columns).toEqual(['displayName', 'email']);
  });

  it('stored the column names and no row data', async () => {
    const row = await logRow('conv-happy');
    const stored = JSON.stringify(row);
    expect(stored).not.toContain('Jan de Vries');
    expect(stored).not.toContain('jan@example.com');
  });
});

describe('POST /api/messages — a caller Identity Atlas does not know', () => {
  it('records the attempt without answering it', async () => {
    const { callerFromTurn } = await import('../src/teamsbot/auth.js');
    const unknown = randomUUID();
    callerFromTurn.mockResolvedValueOnce({ ok: true, oid: unknown });

    const res = await post(activity('which groups am I in?', 'conv-unknown'));
    expect(res.status).toBeLessThan(300);

    const row = await logRow('conv-unknown');
    expect(row.outcome).toBe('unknown-caller');
    expect(row.callerOid).toBe(unknown);
    expect(row.callerPrincipalId).toBeNull();
    expect(row.definition).toBeNull();

    await pool.query(`DELETE FROM "BotConversations" WHERE "callerOid" = $1`, [unknown]);
  });
});

describe('GET /api/bot-answers/:id — the deep link', () => {
  it('refuses a caller with no identity, even on an install with auth switched off', async () => {
    // The contract app runs with auth disabled, so requirePermission is a no-op
    // and `req.user` is absent — exactly the shape a read API key or an open-mode
    // install presents. A bot answer belongs to the person who asked it, so
    // there is no sensible caller here and the route must not serve one. The
    // signed-in behaviour is covered in src/routes/teamsBot.test.js.
    const row = await logRow('conv-happy');
    const res = await agent.get(`/api/bot-answers/${row.id}`);

    expect(res.status).toBe(403);
    expect(res.body.rows).toBeUndefined();
  });
});
