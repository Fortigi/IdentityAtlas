// Teams bot (POC) — the turn handler.
//
// Thin on purpose. Everything that decides anything lives in service.js (what
// the answer is), card.js (what it looks like) and auth.js (who is asking); this
// file only knows about Teams: typing indicators, conversation-update events,
// sign-in invokes, and how to put an attachment on the wire. That split is what
// lets the interesting behaviour be unit-tested without a Bot Framework adapter,
// a channel, or a tenant.

import { CardFactory, MessageFactory, TeamsActivityHandler } from 'botbuilder';
import { answerMessage, isHelp } from './service.js';
import { welcomeCard } from './card.js';
import { callerFromTurn, withTokenTimeout, CONNECTION_NAME } from './auth.js';
import { detectLanguage, strings } from './text.js';

/** How often to refresh the typing indicator; Teams drops it after a few seconds. */
const TYPING_EVERY_MS = 4000;

export class IdentityAtlasBot extends TeamsActivityHandler {
  /**
   * @param {object} [deps]  injected for tests — the real pipeline by default
   */
  constructor(deps = {}) {
    super();
    this.answer = deps.answerMessage ?? answerMessage;
    this.resolveTurnCaller = deps.callerFromTurn ?? callerFromTurn;
    this.connectionName = deps.connectionName ?? CONNECTION_NAME;

    this.onMessage(async (context, next) => {
      await this.handleQuestion(context);
      await next();
    });

    // The welcome card, on install. `membersAdded` fires for the bot being added
    // to a personal chat, which is the POC's only scope.
    this.onMembersAdded(async (context, next) => {
      const botId = context.activity.recipient?.id;
      const added = context.activity.membersAdded ?? [];
      if (added.some(m => m.id !== botId)) {
        await context.sendActivity(MessageFactory.attachment(welcomeCard('en')));
      }
      await next();
    });
  }

  /** One question, start to finish. */
  async handleQuestion(context) {
    const question = String(context.activity.text ?? '').trim();
    const language = detectLanguage(question);
    const t = strings(language);

    // Logged before ANYTHING that can block, so the log always distinguishes
    // "the activity never arrived" from "the activity arrived and something
    // downstream hung". Those two look identical without this line, and telling
    // them apart is most of the work when a chat goes quiet.
    const turn = context.activity;
    console.log(
      `teams-bot: turn type=${turn.type} name=${turn.name ?? '-'} `
      + `conversation=${turn.conversation?.id ?? '-'} chars=${question.length}`,
    );

    // `help` is answered before anyone is identified. It reveals nothing about
    // the directory — it is three example questions — and needing to sign in
    // first makes the one command that should always work the one that cannot
    // be used to check whether the bot is reachable at all.
    if (isHelp(question)) {
      return context.sendActivity(MessageFactory.attachment(welcomeCard(language)));
    }

    const caller = await this.resolveTurnCaller(context, { connectionName: this.connectionName });
    console.log(`teams-bot: turn caller=${caller.ok ? 'resolved' : caller.reason}`);
    if (!caller.ok) return this.handleNoCaller(context, caller.reason, t);

    // Say something VISIBLE before the wait starts.
    //
    // A typing indicator alone is not enough here and testing proved it: Teams
    // renders it as a small transient dot animation, drops it after a few
    // seconds, and does not always show it at all on desktop. An answer takes
    // one to three minutes, so the chat sits apparently dead for longer than
    // anyone will wait before deciding the bot is broken — which is exactly
    // what happened. A posted message stays on screen for the whole wait and
    // also says how long to expect, which the indicator cannot.
    await context.sendActivity(t.working).catch(() => {});

    // The indicator on top of it, re-sent because Teams expires it.
    const typing = setInterval(() => {
      context.sendActivity({ type: 'typing' }).catch(() => {});
    }, TYPING_EVERY_MS);
    await context.sendActivity({ type: 'typing' }).catch(() => {});

    try {
      const { attachment } = await this.answer(
        { oid: caller.oid, conversationId: context.activity.conversation?.id, text: question },
        { onProgress: (text) => context.sendActivity(text).then(() => {}) },
      );
      await context.sendActivity(MessageFactory.attachment(attachment));
    } finally {
      clearInterval(typing);
    }
  }

  /**
   * No usable caller. Each reason gets its own reply, because they need
   * different things from the person reading them: consent, an administrator,
   * or nothing at all.
   */
  async handleNoCaller(context, reason, t) {
    if (reason === 'no-token') {
      return context.sendActivity(MessageFactory.attachment(await this.signInCard(context)));
    }
    if (reason === 'forbidden') {
      return context.sendActivity(
        'Your account is signed in, but it has no permission to ask Identity Atlas questions. Ask your Identity Atlas administrator for the role that grants it.',
      );
    }
    return context.sendActivity(t.error);
  }

  /**
   * The sign-in card, carrying the token-exchange resource that makes Teams do
   * the sign-in SILENTLY.
   *
   * A bare OAuthCard is the difference between one tap and none — and, worse,
   * between working and not: Teams only attempts the exchange when the card
   * advertises a `tokenExchangeResource`, and without that attempt the
   * `signin/tokenExchange` invoke never arrives, nothing is ever redeemed, and
   * the card returns with "Something went wrong. Please try again." on a loop.
   * The resource is produced by the token service for this connection, so it
   * cannot be hand-built; it has to be asked for per turn.
   *
   * Falls back to a plain card if the token service cannot be reached, because a
   * card the caller can tap beats no reply at all.
   */
  async signInCard(context) {
    const title = 'Sign in to Identity Atlas';
    const text = 'I need to know who you are before I can answer. This uses your existing account — it takes one tap.';
    try {
      const client = context.turnState.get(context.adapter.UserTokenClientKey);
      const resource = await withTokenTimeout(
        client.getSignInResource(this.connectionName, context.activity, null),
        'getSignInResource',
      );
      return CardFactory.oauthCard(
        this.connectionName, title, text,
        resource.signInLink, resource.tokenExchangeResource, resource.tokenPostResource,
      );
    } catch (err) {
      console.error(`teams-bot: could not build a sign-in resource: ${err.message}`);
      return CardFactory.oauthCard(this.connectionName, title, text);
    }
  }

  // Silent SSO in Teams: the client exchanges a token without showing the card.
  // Both invokes mean "try again, the token should be there now", so both simply
  // re-run the turn rather than carrying state between them.
  async handleTeamsSigninTokenExchange(context) {
    await this.handleQuestion(context);
  }

  async handleTeamsSigninVerifyState(context) {
    await this.handleQuestion(context);
  }
}

