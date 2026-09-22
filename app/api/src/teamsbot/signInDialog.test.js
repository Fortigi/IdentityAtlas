// The sign-in dialog: what happens once OAuthPrompt has produced a token (or
// failed to).
//
// OAuthPrompt itself is Microsoft's and is not re-tested here — the point of
// adopting it was to stop owning that sequence. What IS ours is the second
// waterfall step: turning a token into a caller, refusing the ones who may not
// ask, and answering the question the caller typed BEFORE signing in. That last
// one is the whole reason the question travels in dialog options, and it is the
// thing the hand-rolled version could never do.

import { describe, it, expect, vi } from 'vitest';
import { SignInAndAnswerDialog, replyForRefusal } from './signInDialog.js';
import { attachment } from './card.js';
import { EN, NL, strings } from './text.js';

const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ANSWER = attachment([{ type: 'TextBlock', text: 'the answer', wrap: true }]);

/** Drive the dialog's second step directly, with a fake waterfall step context. */
function stepContext({ token = 'a.b.c', question = 'which groups is Jan in?', language = 'en' } = {}) {
  const sent = [];
  return {
    sent,
    step: {
      options: { question, language },
      result: token === null ? {} : { token },
      context: {
        activity: { conversation: { id: 'conv-1' } },
        sendActivity: vi.fn(async (a) => { sent.push(a); return { id: 'x' }; }),
      },
      endDialog: vi.fn(async () => ({ status: 'complete' })),
    },
  };
}

function makeDialog(over = {}) {
  return new SignInAndAnswerDialog({
    connectionName: 'test-connection',
    callerFromToken: vi.fn(async () => ({ ok: true, oid: OID })),
    answerMessage: vi.fn(async () => ({ attachment: ANSWER, outcome: 'answered', conversationLogId: 'log-1' })),
    ...over,
  });
}

const texts = (sent) => sent.filter(a => typeof a === 'string');

describe('answering once signed in', () => {
  it('answers the question that was asked BEFORE the sign-in', async () => {
    // The point of the rewrite. The caller typed the question, got prompted to
    // sign in, and must not have to type it again.
    const answerMessage = vi.fn(async () => ({ attachment: ANSWER, outcome: 'answered', conversationLogId: null }));
    const dialog = makeDialog({ answerMessage });
    const { step } = stepContext({ question: 'van welke groepen ben ik eigenaar?' });

    await dialog.answerTheQuestion(step);

    expect(answerMessage).toHaveBeenCalledTimes(1);
    expect(answerMessage.mock.calls[0][0]).toEqual({
      oid: OID, conversationId: 'conv-1', text: 'van welke groepen ben ik eigenaar?',
    });
  });

  it('verifies the token OAuthPrompt handed it, rather than trusting the turn', async () => {
    const callerFromToken = vi.fn(async () => ({ ok: true, oid: OID }));
    const dialog = makeDialog({ callerFromToken });
    const { step } = stepContext({ token: 'the.access.token' });

    await dialog.answerTheQuestion(step);
    expect(callerFromToken).toHaveBeenCalledWith('the.access.token');
  });

  it('says something visible before the wait, in the caller\'s language', async () => {
    const dialog = makeDialog();
    const { step, sent } = stepContext({ language: 'nl' });

    await dialog.answerTheQuestion(step);
    expect(texts(sent)).toContain(NL.working);
  });

  it('sends the answer card and closes the dialog', async () => {
    const dialog = makeDialog();
    const { step, sent } = stepContext();

    await dialog.answerTheQuestion(step);

    expect(sent.find(a => a.attachments?.length)?.attachments[0]).toEqual(ANSWER);
    expect(step.endDialog).toHaveBeenCalled();
  });

  it('gives the pipeline a way to report progress', async () => {
    let progress;
    const answerMessage = vi.fn(async (_m, deps) => {
      progress = deps.onProgress;
      return { attachment: ANSWER, outcome: 'answered', conversationLogId: null };
    });
    await makeDialog({ answerMessage }).answerTheQuestion(stepContext().step);
    expect(typeof progress).toBe('function');
  });
});

describe('when the caller cannot be answered', () => {
  it.each([
    ['no-token', /could not sign you in/i],
    ['forbidden', /no permission to ask/i],
    ['invalid-token', new RegExp(EN.error)],
  ])('refuses %s without reaching the pipeline', async (reason, expected) => {
    const answerMessage = vi.fn();
    const dialog = makeDialog({ callerFromToken: vi.fn(async () => ({ ok: false, reason })), answerMessage });
    const { step, sent } = stepContext();

    await dialog.answerTheQuestion(step);

    expect(texts(sent).join(' ')).toMatch(expected);
    expect(answerMessage).not.toHaveBeenCalled();
    expect(step.endDialog).toHaveBeenCalled();
  });

  it('does not announce work it will not do', async () => {
    // Saying "on it" and then refusing reads as the bot losing the question.
    const dialog = makeDialog({ callerFromToken: vi.fn(async () => ({ ok: false, reason: 'forbidden' })) });
    const { step, sent } = stepContext();

    await dialog.answerTheQuestion(step);
    expect(texts(sent)).not.toContain(EN.working);
  });

  it('treats a prompt that produced no token as a failed sign-in', async () => {
    // OAuthPrompt returns an empty result when it times out or is cancelled.
    const callerFromToken = vi.fn(async () => ({ ok: false, reason: 'no-token' }));
    const dialog = makeDialog({ callerFromToken });
    const { step } = stepContext({ token: null });

    await dialog.answerTheQuestion(step);
    expect(callerFromToken).toHaveBeenCalledWith(undefined);
  });
});

describe('replyForRefusal', () => {
  it('points a forbidden caller at an administrator, not at signing in again', async () => {
    // These need different things from the reader. Telling someone to sign in
    // when their role is the problem produces an endless sign-in loop.
    expect(replyForRefusal('forbidden', EN)).toMatch(/administrator/i);
    expect(replyForRefusal('forbidden', EN)).not.toMatch(/sign in/i);
  });

  it('tells a failed sign-in how to retry', () => {
    expect(replyForRefusal('no-token', EN)).toMatch(/ask again/i);
  });

  it('never explains a rejected token to the chat', () => {
    // An invalid token is a server-side concern; the detail belongs in the log.
    const reply = replyForRefusal('invalid-token', strings('en'));
    expect(reply).toBe(EN.error);
    expect(reply).not.toMatch(/token/i);
  });
});
