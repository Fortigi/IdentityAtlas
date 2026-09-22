// Teams bot (POC) — the turn handler.
//
// Thin on purpose. What the answer IS lives in service.js, what it looks like in
// card.js, who is asking in auth.js, and the sign-in sequence in
// signInDialog.js. This file knows only about Teams: which turns exist, the
// welcome, the typing indicator, and saving dialog state at the end of a turn.
//
// EVERY turn is handed to the dialog, not just messages. Teams SSO arrives as
// `signin/tokenExchange` and `signin/verifyState` invokes, and the prompt that
// is waiting for them only sees them if the dialog runs on those turns too. A
// bot that ran dialogs on `message` alone would sit waiting forever while the
// answer went past it.

import { MessageFactory, TeamsActivityHandler } from 'botbuilder';
import { isHelp } from './service.js';
import { welcomeCard } from './card.js';
import { detectLanguage } from './text.js';

/** How often to refresh the typing indicator; Teams drops it after a few seconds. */
const TYPING_EVERY_MS = 4000;

export class IdentityAtlasBot extends TeamsActivityHandler {
  /**
   * @param {object} args
   * @param {import('botbuilder').ConversationState} args.conversationState
   * @param {import('./signInDialog.js').SignInAndAnswerDialog} args.dialog
   */
  constructor({ conversationState, dialog }) {
    super();
    this.conversationState = conversationState;
    this.dialogState = conversationState.createProperty('teamsbot-dialog-state');
    this.dialog = dialog;

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

    // Dialog state is per conversation and has to outlive the turn — the whole
    // point is that a question survives a sign-in round trip. Saved after every
    // turn, including the invokes.
    this.onDialog(async (context, next) => {
      await this.conversationState.saveChanges(context, false);
      await next();
    });
  }

  /** One question, start to finish. */
  async handleQuestion(context) {
    const question = String(context.activity.text ?? '').trim();
    const language = detectLanguage(question);

    // Logged before anything that can block, so the log always separates "the
    // activity never arrived" from "the activity arrived and something hung".
    const turn = context.activity;
    console.log(
      `teams-bot: turn type=${turn.type} name=${turn.name ?? '-'} `
      + `conversation=${turn.conversation?.id ?? '-'} chars=${question.length}`,
    );

    // `help` is answered before anyone is identified: three example questions
    // reveal nothing about the directory, and needing to sign in first makes the
    // one command that should always work useless for checking the bot is up.
    if (isHelp(question)) {
      return context.sendActivity(MessageFactory.attachment(welcomeCard(language)));
    }

    // Every outbound activity and what the channel said about it. An OAuth card
    // that is built, handed to the adapter and then never appears is otherwise
    // indistinguishable from one that was never built — and that difference is
    // the whole question when a sign-in never shows up. Typing indicators are
    // skipped: they are sent every few seconds and would bury everything else.
    context.onSendActivities(async (ctx, activities, next) => {
      const interesting = activities.filter(a => a.type !== 'typing');
      try {
        const responses = await next();
        for (const a of interesting) {
          const kind = a.attachments?.[0]?.contentType ?? a.type;
          console.log(
            `teams-bot: send ${kind} replyTo=${a.replyToId ?? '-'} `
            + `-> ${JSON.stringify(responses) ?? 'undefined'}`,
          );
        }
        return responses;
      } catch (err) {
        // An error thrown here is normally swallowed into the turn's failure
        // and reported as a generic "something went wrong", losing which
        // activity caused it and what the channel said.
        for (const a of interesting) {
          console.error(`teams-bot: send FAILED ${a.attachments?.[0]?.contentType ?? a.type}: ${err.message}`);
        }
        throw err;
      }
    });

    // Keep the chat alive while the dialog works. The dialog posts its own
    // visible acknowledgement once it knows it has a caller to answer for.
    const typing = setInterval(() => {
      context.sendActivity({ type: 'typing' }).catch(() => {});
    }, TYPING_EVERY_MS);
    await context.sendActivity({ type: 'typing' }).catch(() => {});

    try {
      await this.dialog.run(context, this.dialogState, { question, language });
    } finally {
      clearInterval(typing);
    }
  }

  // Silent SSO. Both invokes carry the exchange the waiting OAuthPrompt needs,
  // so both run the dialog rather than trying to interpret the invoke here.
  async handleTeamsSigninTokenExchange(context) {
    console.log('teams-bot: turn signin/tokenExchange');
    await this.dialog.run(context, this.dialogState);
  }

  async handleTeamsSigninVerifyState(context) {
    console.log('teams-bot: turn signin/verifyState');
    await this.dialog.run(context, this.dialogState);
  }
}
