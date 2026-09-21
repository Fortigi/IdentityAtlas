// Teams bot (POC) — the turn handler.
//
// Thin on purpose. Everything that decides anything lives in service.js (what
// the answer is), card.js (what it looks like) and auth.js (who is asking); this
// file only knows about Teams: typing indicators, conversation-update events,
// sign-in invokes, and how to put an attachment on the wire. That split is what
// lets the interesting behaviour be unit-tested without a Bot Framework adapter,
// a channel, or a tenant.

import { CardFactory, MessageFactory, TeamsActivityHandler } from 'botbuilder';
import { answerMessage } from './service.js';
import { welcomeCard } from './card.js';
import { callerFromTurn, CONNECTION_NAME } from './auth.js';
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

    const caller = await this.resolveTurnCaller(context, { connectionName: this.connectionName });
    if (!caller.ok) return this.handleNoCaller(context, caller.reason, t);

    // Keep the chat alive while the model writes. Teams drops a typing
    // indicator after a few seconds, so it is re-sent rather than sent once —
    // an answer here is measured in tens of seconds, not milliseconds.
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
      return context.sendActivity(MessageFactory.attachment(CardFactory.oauthCard(
        this.connectionName,
        'Sign in to Identity Atlas',
        'I need to know who you are before I can answer. This uses your existing account — it takes one tap.',
      )));
    }
    if (reason === 'forbidden') {
      return context.sendActivity(
        'Your account is signed in, but it has no permission to ask Identity Atlas questions. Ask your Identity Atlas administrator for the role that grants it.',
      );
    }
    return context.sendActivity(t.error);
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

