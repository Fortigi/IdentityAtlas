// Teams bot (POC) — sign in, then answer, as one dialog.
//
// WHY A DIALOG AT ALL. Teams SSO is not a single call. The bot sends an OAuth
// card carrying a token-exchange resource; Teams silently exchanges it and posts
// a `signin/tokenExchange` invoke back; that invoke has to be redeemed against
// the token service, deduplicated across a user's Teams clients, and answered
// with the right invoke response — and only then is there a token. The question
// the caller typed has to survive all of that and still get answered without
// being retyped.
//
// The first version of this file did not exist: the bot hand-rolled every step
// above. It failed three times in a row, each time silently — the card carried
// no exchange resource so Teams never attempted SSO; nothing redeemed the
// exchange when it did arrive; and finally the adapter declined to send the card
// at all. `OAuthPrompt` owns that whole sequence and is the part of the Bot
// Framework that is actually tested against Teams, so it owns it here.
//
// The waterfall is deliberately two steps and nothing else:
//   1. prompt for the token (OAuthPrompt shows a card only if it has to)
//   2. verify who that token belongs to, and answer their question
//
// The question rides in the dialog options, so the caller types it once even
// when a sign-in round trip happens in between.

import { ComponentDialog, DialogSet, DialogTurnStatus, OAuthPrompt, WaterfallDialog } from 'botbuilder-dialogs';
import { MessageFactory } from 'botbuilder';
import { callerFromToken, CONNECTION_NAME } from './auth.js';
import { answerMessage } from './service.js';
import { strings } from './text.js';

const OAUTH_PROMPT = 'teamsbot-oauth-prompt';
const WATERFALL = 'teamsbot-waterfall';
export const ROOT_DIALOG = 'teamsbot-root';

/** How long a caller has to finish signing in before the prompt gives up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export class SignInAndAnswerDialog extends ComponentDialog {
  /**
   * @param {object} [deps]  injected for tests; defaults are the real pipeline
   */
  constructor(deps = {}) {
    super(ROOT_DIALOG);
    this.answer = deps.answerMessage ?? answerMessage;
    this.resolveCaller = deps.callerFromToken ?? callerFromToken;

    this.addDialog(new OAuthPrompt(OAUTH_PROMPT, {
      connectionName: deps.connectionName ?? CONNECTION_NAME,
      title: 'Sign in',
      text: 'I need to know who you are before I can answer. This uses your existing account.',
      timeout: SIGN_IN_TIMEOUT_MS,
      // A stray message while the prompt is waiting ends it rather than being
      // swallowed: someone who types a second question instead of signing in
      // should get that question treated as a question.
      endOnInvalidMessage: true,
    }));

    this.addDialog(new WaterfallDialog(WATERFALL, [
      this.promptForToken.bind(this),
      this.answerTheQuestion.bind(this),
    ]));

    this.initialDialogId = WATERFALL;
  }

  /** Step 1 — get a token. Shows a card only when there isn't one already. */
  async promptForToken(step) {
    return step.beginDialog(OAUTH_PROMPT);
  }

  /** Step 2 — who is that, and what did they want to know? */
  async answerTheQuestion(step) {
    const question = String(step.options?.question ?? '').trim();
    const language = step.options?.language ?? 'en';
    const t = strings(language);
    const token = step.result?.token;

    const caller = await this.resolveCaller(token);
    console.log(`teams-bot: dialog caller=${caller.ok ? 'resolved' : caller.reason}`);

    if (!caller.ok) {
      await step.context.sendActivity(replyForRefusal(caller.reason, t));
      return step.endDialog();
    }

    // Visible acknowledgement before a wait measured in minutes. See handler.js.
    await step.context.sendActivity(t.working).catch(() => {});

    const { attachment } = await this.answer(
      { oid: caller.oid, conversationId: step.context.activity.conversation?.id, text: question },
      { onProgress: (text) => step.context.sendActivity(text).then(() => {}) },
    );
    await step.context.sendActivity(MessageFactory.attachment(attachment));
    return step.endDialog();
  }

  /**
   * Run this dialog for the current turn, starting it with the question when
   * nothing is in flight.
   *
   * Every turn goes through here, including the `signin/*` invokes — that is how
   * the prompt gets to see the exchange it is waiting for, and why a bot that
   * only ran dialogs on `message` turns would wait forever.
   */
  async run(context, accessor, options = {}) {
    const dialogs = new DialogSet(accessor);
    dialogs.add(this);
    const dialogContext = await dialogs.createContext(context);
    const result = await dialogContext.continueDialog();
    // The dialog's own progress, per turn. A waterfall that is waiting looks
    // exactly like one that never started unless the status is written down,
    // and "waiting" vs "never started" are completely different faults.
    let status = result.status;
    if (result.status === DialogTurnStatus.empty) {
      status = (await dialogContext.beginDialog(this.id, options)).status;
    }
    console.log(
      `teams-bot: dialog status=${status} depth=${dialogContext.stack.length} `
      + `delivery=${context.activity.deliveryMode ?? 'normal'}`,
    );
  }
}

/** What to say to someone the bot will not answer, by reason. */
export function replyForRefusal(reason, t) {
  if (reason === 'forbidden') {
    return 'Your account is signed in, but it has no permission to ask Identity Atlas questions. '
      + 'Ask your Identity Atlas administrator for the role that grants it.';
  }
  // 'no-token' means the sign-in did not finish — the prompt has already shown
  // its card, so this only has to say what happens next.
  if (reason === 'no-token') return 'I could not sign you in, so I have not answered. Ask again to retry.';
  return t.error;
}
