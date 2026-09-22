// Teams bot (POC) — the HTTP surface.
//
//   POST /api/messages              the Bot Framework endpoint Teams posts to
//   GET  /api/bot-answers/:id       the full report behind a card's deep link
//
// Both are behind the `teamsBot` feature flag, which is OFF by default. While it
// is off /api/messages does not exist at all (404) — not "exists and rejects",
// because an endpoint that answers 401 tells a scanner there is a bot here to
// come back for.
//
// /api/messages is NOT behind authMiddleware. It cannot be: the caller is the
// Bot Framework service, not a signed-in browser, and it authenticates with its
// own token. That token is verified by the adapter on every activity before the
// handler sees it (`ConfigurationBotFrameworkAuthentication`), and the activity
// is then only acted on for a caller whose Teams SSO token ALSO verifies
// (teamsbot/auth.js). Two separate proofs: the channel is real, and the person
// is real.
//
// /api/bot-answers/:id is an ordinary signed-in route and is gated normally.

import { Router } from 'express';
import {
  CloudAdapter, ConfigurationBotFrameworkAuthentication, ConversationState,
  MemoryStorage, TeamsSSOTokenExchangeMiddleware,
} from 'botbuilder';
import { SignInAndAnswerDialog } from '../teamsbot/signInDialog.js';
import { requirePermission } from '../middleware/auth.js';
import { requireFeature } from '../featureFlags.js';
import { IdentityAtlasBot } from '../teamsbot/handler.js';
import { CONNECTION_NAME } from '../teamsbot/auth.js';
import { findAnswerForCaller } from '../teamsbot/log.js';
import { runSpec } from '../nlreports/service.js';
import { forLog } from '../nlreports/assistantHttp.js';

// TWO routers, because they authenticate differently and must be mounted
// differently. `messagesRouter` is mounted WITHOUT authMiddleware — the caller
// is the Bot Framework service and has no user Bearer token, so authMiddleware
// would answer 401 to Teams on every activity. `botAnswersRouter` is an ordinary
// signed-in surface and is mounted behind it. Keeping them separate is what
// stops a future route being added to "the bot router" and quietly inheriting
// the unauthenticated mount.
const messagesRouter = Router();
const botAnswersRouter = Router();

/**
 * An invoke's value, safe to log: the shape and the reason, never a token.
 *
 * `signin/tokenExchange` carries the caller's access token in `value.token`,
 * and a container log is exactly where that must not end up.
 */
export function redact(value) {
  if (value == null || typeof value !== 'object') return String(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /token|secret|password/i.test(k) ? `[redacted ${String(v ?? '').length} chars]` : v;
  }
  return forLog(JSON.stringify(out), 500);
}

// Built once, lazily: constructing the adapter reads the bot's credentials, and
// an install that never switches the flag on should never need them to exist.
let adapter = null;
let bot = null;

export function botAdapter() {
  if (!adapter) {
    const auth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: process.env.TEAMS_BOT_APP_ID,
      MicrosoftAppPassword: process.env.TEAMS_BOT_APP_PASSWORD,
      MicrosoftAppTenantId: process.env.TEAMS_BOT_APP_TENANT_ID,
      MicrosoftAppType: process.env.TEAMS_BOT_APP_TYPE || 'SingleTenant',
    });
    adapter = new CloudAdapter(auth);

    // FIRST middleware, ahead of the SSO one below, because that one can end a
    // turn without calling next(): when a token exchange fails it answers the
    // invoke and returns, so nothing downstream ever runs and nothing is
    // logged. An exchange that Teams attempted and the token service refused is
    // then indistinguishable from one Teams never attempted — and those need
    // opposite fixes. This is the only place that difference is visible.
    adapter.use({
      onTurn: async (context, next) => {
        const { type, name, value } = context.activity;
        const label = `${type}${name ? ` name=${name}` : ''}`;
        // A signin/* invoke carries WHY in its value — `signin/failure` is
        // Teams saying the sign-in it attempted did not work, and the payload
        // says what it objected to. Without it the bot knows only that
        // something failed. Tokens are redacted: signin/tokenExchange carries
        // the caller's access token, which must not reach a container log.
        console.log(`teams-bot: inbound ${label}${name?.startsWith('signin/') ? ` value=${redact(value)}` : ''}`);
        await next();
        console.log(`teams-bot: inbound ${label} — middleware chain completed`);
      },
    });

    // Silent SSO. Without this the bot shows a sign-in card, Teams performs the
    // exchange and posts `signin/tokenExchange` — and nothing ever redeems it,
    // so the token never reaches the token store, `getUserToken` keeps returning
    // null, and the card comes back with "Something went wrong. Please try
    // again." forever. This middleware is what actually redeems the exchange,
    // and it also deduplicates: a user signed into Teams on desktop and phone
    // produces one invoke per client with the same `value.id`, and only one may
    // be processed. On success it calls next(), so the turn still runs and the
    // question the caller already asked is answered rather than retyped.
    //
    // MemoryStorage is the deduplication store. Correct for a single container,
    // which is what this POC is; more than one replica needs a shared store, for
    // the same reason teamsbot/state.js does.
    adapter.use(new TeamsSSOTokenExchangeMiddleware(new MemoryStorage(), CONNECTION_NAME));
    // A crash inside a turn must not take the answer down silently: the caller
    // is told, and the detail goes to the server log, never to the chat.
    adapter.onTurnError = async (context, error) => {
      console.error(`teams-bot: unhandled turn error: ${forLog(error.message, 300)}`);
      await context.sendActivity('Something went wrong. It has been logged.').catch(() => {});
    };
  }
  return adapter;
}

function botInstance() {
  if (!bot) {
    // One storage for both jobs it has: the SSO middleware's exchange
    // deduplication, and the conversation state that lets a question survive a
    // sign-in round trip. Correct for a single container, which is what this POC
    // is; more than one replica needs a shared store, for the same reason
    // teamsbot/state.js does.
    const storage = new MemoryStorage();
    const conversationState = new ConversationState(storage);
    bot = new IdentityAtlasBot({ conversationState, dialog: new SignInAndAnswerDialog() });
  }
  return bot;
}

// The Bot Framework endpoint. `requireFeature` runs first, so a disabled bot is
// indistinguishable from an install that never had one.
messagesRouter.post('/messages', requireFeature('teamsBot'), async (req, res) => {
  try {
    await botAdapter().process(req, res, (context) => botInstance().run(context));
  } catch (err) {
    // process() normally writes the response itself; this is the case where it
    // could not (a malformed activity, a credential problem at startup).
    console.error(`teams-bot: /api/messages failed: ${forLog(err.message, 300)}`);
    if (!res.headersSent) res.status(500).json({ error: 'Request failed' });
  }
});

/**
 * The full report behind a card's "Open the full report" link.
 *
 * Re-runs the stored definition rather than returning stored rows: a report
 * always reflects the data as it is now, which is the same promise saved reports
 * make. It is scoped to the person who asked the question — the link travels in
 * a chat message and chat messages get forwarded.
 */
botAnswersRouter.get(
  '/bot-answers/:id',
  requirePermission('data.read.reports'),
  requireFeature('teamsBot'),
  async (req, res) => {
    const oid = req.user?.oid;
    if (!oid) return res.status(403).json({ error: 'This report belongs to a Teams conversation' });
    try {
      const row = await findAnswerForCaller(req.params.id, oid);
      // Not found and not-yours are the same answer on purpose: distinguishing
      // them tells a holder of a forwarded link that the id was at least real.
      if (!row) return res.status(404).json({ error: 'No such answer' });
      const result = await runSpec(row.definition);
      if (!result.ok) return res.status(400).json({ error: 'That report can no longer be run', errors: result.errors });
      res.json({ question: row.question, ...result });
    } catch (err) {
      console.error(`teams-bot: bot-answer ${forLog(req.params.id, 64)} failed: ${forLog(err.message, 300)}`);
      res.status(500).json({ error: 'Request failed' });
    }
  },
);

/** Test seam: drop the memoised adapter and bot so a test can supply its own env. */
export function __reset() {
  adapter = null;
  bot = null;
}

export { messagesRouter, botAnswersRouter };
export default messagesRouter;
