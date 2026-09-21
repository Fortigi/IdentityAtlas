// The turn handler, driven through the Bot Framework's own TestAdapter.
//
// TestAdapter runs a real TurnContext and collects what the bot sends, so these
// are the Teams-facing behaviours that cannot be asserted anywhere else: that a
// caller who has not consented gets a sign-in card rather than an error, that a
// caller without permission is told which of the two problems they have, that
// the chat is kept alive while the model writes, and that installing the bot
// produces a welcome.
//
// What the answer IS stays in service.test.js — here it is always a stub.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestAdapter } from 'botbuilder';
import { IdentityAtlasBot } from './handler.js';
import { attachment } from './card.js';
import { EN } from './text.js';

const ANSWER = attachment([{ type: 'TextBlock', text: 'the answer', wrap: true }]);

/** Drive one activity through the bot and return everything it sent. */
async function run(activity, { caller = { ok: true, oid: 'oid-1' }, answer = ANSWER, answerImpl, sent = [] } = {}) {
  const adapter = new TestAdapter(async (context) => {
    await bot.run(context);
  });
  adapter.onTurnError = async (_ctx, err) => { throw err; };

  const answerMessage = answerImpl ?? vi.fn(async () => ({ attachment: answer, outcome: 'answered', conversationLogId: 'log-1' }));
  const bot = new IdentityAtlasBot({
    answerMessage,
    callerFromTurn: vi.fn(async () => caller),
    connectionName: 'test-connection',
  });

  // TestAdapter records replies in its queue; capture them as they are sent so
  // typing indicators (which it does not queue as messages) are visible too.
  const original = adapter.sendActivities.bind(adapter);
  adapter.sendActivities = async (context, activities) => {
    sent.push(...activities);
    return original(context, activities);
  };

  await adapter.receiveActivity(activity);
  return { sent, answerMessage };
}

const message = (text) => ({ type: 'message', text, from: { id: '29:a' }, conversation: { id: 'c1' } });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe('a question from a known caller', () => {
  it('sends the answer card', async () => {
    const { sent } = await run(message('which groups is Jan in?'));
    const cards = sent.filter(a => a.attachments?.length);
    expect(cards).toHaveLength(1);
    expect(cards[0].attachments[0]).toEqual(ANSWER);
  });

  it('passes the caller, the conversation and the question to the pipeline', async () => {
    const { answerMessage } = await run(message('  which groups is Jan in?  '));
    const [msg] = answerMessage.mock.calls[0];
    expect(msg).toEqual({ oid: 'oid-1', conversationId: 'c1', text: 'which groups is Jan in?' });
  });

  it('starts a typing indicator before the pipeline, not after', async () => {
    // A chat that sits silent for fifty seconds reads as broken. The indicator
    // has to go out before the wait, which is what ordering pins here: the
    // count is taken from INSIDE the pipeline call.
    const sent = [];
    let typingAtCallTime = 0;
    await run(message('q'), {
      sent,
      answerImpl: vi.fn(async () => {
        typingAtCallTime = sent.filter(a => a.type === 'typing').length;
        return { attachment: ANSWER, outcome: 'answered', conversationLogId: null };
      }),
    });
    expect(typingAtCallTime).toBeGreaterThanOrEqual(1);
  });

  it('stops the typing indicator once the answer is sent', async () => {
    const { sent } = await run(message('q'));
    const before = sent.filter(a => a.type === 'typing').length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent.filter(a => a.type === 'typing').length).toBe(before);
  });

  it('gives the pipeline a way to say it is still working', async () => {
    let progress;
    await run(message('q'), {
      answerImpl: vi.fn(async (_msg, deps) => {
        progress = deps.onProgress;
        return { attachment: ANSWER, outcome: 'answered', conversationLogId: null };
      }),
    });
    expect(typeof progress).toBe('function');
  });
});

describe('a caller the bot cannot use', () => {
  it('offers a sign-in card when the caller has not consented yet', async () => {
    const { sent, answerMessage } = await run(message('q'), { caller: { ok: false, reason: 'no-token' } });

    const card = sent.find(a => a.attachments?.length)?.attachments[0];
    expect(card.contentType).toBe('application/vnd.microsoft.card.oauth');
    expect(card.content.connectionName).toBe('test-connection');
    expect(answerMessage).not.toHaveBeenCalled();
  });

  it('tells a caller without permission what is actually wrong', async () => {
    // Not the same as "sign in" and not the same as "something went wrong":
    // this one needs an administrator, and saying so is the difference between
    // a fixed problem and a repeated sign-in loop.
    const { sent, answerMessage } = await run(message('q'), { caller: { ok: false, reason: 'forbidden' } });

    expect(sent.map(a => a.text).join(' ')).toMatch(/no permission to ask/i);
    expect(sent.some(a => a.attachments?.length)).toBe(false);
    expect(answerMessage).not.toHaveBeenCalled();
  });

  it('does not explain a rejected token to the chat', async () => {
    // An invalid token is a server-side concern. The chat gets the generic
    // error; the detail is in the log.
    const { sent, answerMessage } = await run(message('q'), { caller: { ok: false, reason: 'invalid-token' } });

    expect(sent.map(a => a.text).join(' ')).toContain(EN.error);
    expect(sent.map(a => a.text).join(' ')).not.toMatch(/token/i);
    expect(answerMessage).not.toHaveBeenCalled();
  });

  it('never starts a typing indicator for a caller it will not answer', async () => {
    const { sent } = await run(message('q'), { caller: { ok: false, reason: 'forbidden' } });
    expect(sent.some(a => a.type === 'typing')).toBe(false);
  });
});

describe('silent SSO', () => {
  const invoke = (name) => ({
    type: 'invoke',
    name,
    value: {},
    from: { id: '29:a' },
    conversation: { id: 'c1' },
    text: 'which groups is Jan in?',
  });

  it.each(['signin/tokenExchange', 'signin/verifyState'])(
    'retries the question after %s, rather than asking again', async (name) => {
      // Both invokes mean "the token should be there now". If they did not
      // re-run the turn, a caller who consented would have to retype the
      // question they already asked.
      const { answerMessage } = await run(invoke(name));
      expect(answerMessage).toHaveBeenCalledTimes(1);
      expect(answerMessage.mock.calls[0][0].text).toBe('which groups is Jan in?');
    },
  );

  it('offers the sign-in card again when the token still is not there', async () => {
    const { sent, answerMessage } = await run(invoke('signin/tokenExchange'), { caller: { ok: false, reason: 'no-token' } });
    expect(answerMessage).not.toHaveBeenCalled();
    expect(sent.find(a => a.attachments?.length)?.attachments[0].contentType)
      .toBe('application/vnd.microsoft.card.oauth');
  });
});

describe('installing the bot', () => {
  const conversationUpdate = (membersAdded) => ({
    type: 'conversationUpdate',
    membersAdded,
    recipient: { id: '28:bot' },
    from: { id: '29:a' },
    conversation: { id: 'c1' },
  });

  it('welcomes the person who added it', async () => {
    const { sent } = await run(conversationUpdate([{ id: '29:a' }]));
    const card = sent.find(a => a.attachments?.length)?.attachments[0];
    const body = JSON.stringify(card.content.body);
    expect(body).toContain(EN.welcome);
    for (const example of EN.examples) expect(body).toContain(example);
  });

  it('does not welcome itself being added', async () => {
    // membersAdded contains the BOT when it is installed into a conversation.
    // A handler that does not check produces a welcome card addressed to nobody.
    const { sent } = await run(conversationUpdate([{ id: '28:bot' }]));
    expect(sent.some(a => a.attachments?.length)).toBe(false);
  });

  it('welcomes when a person is added alongside the bot', async () => {
    const { sent } = await run(conversationUpdate([{ id: '28:bot' }, { id: '29:a' }]));
    expect(sent.some(a => a.attachments?.length)).toBe(true);
  });
});
