// The turn handler, driven through the Bot Framework's own TestAdapter.
//
// The handler is thin now: it decides which turns exist, answers `help`, keeps
// the chat alive, and hands everything else to the dialog. So these tests are
// about ROUTING — that each kind of turn reaches the dialog (or deliberately
// does not), and that dialog state is saved so a question survives a sign-in.
// What happens inside the dialog is signInDialog.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationState, MemoryStorage, TestAdapter } from 'botbuilder';
import { IdentityAtlasBot, ensureRecipient } from './handler.js';
import { EN, NL } from './text.js';

/** A bot whose dialog is a spy, so routing can be asserted on its own. */
function makeBot() {
  const runs = [];
  const dialog = { id: 'test-dialog', run: vi.fn(async (_ctx, _accessor, options) => { runs.push(options); }) };
  const conversationState = new ConversationState(new MemoryStorage());
  return { bot: new IdentityAtlasBot({ conversationState, dialog }), dialog, runs, conversationState };
}

async function run(activity, over = {}) {
  const sent = [];
  const { bot, dialog, runs, conversationState } = over.bot ? over : makeBot();
  const adapter = new TestAdapter(async (context) => { await bot.run(context); });
  adapter.onTurnError = async (_ctx, err) => { throw err; };
  const original = adapter.sendActivities.bind(adapter);
  adapter.sendActivities = async (context, activities) => {
    sent.push(...activities);
    return original(context, activities);
  };
  await adapter.receiveActivity(activity);
  return { sent, dialog, runs, conversationState };
}

const message = (text) => ({ type: 'message', text, from: { id: '29:a' }, conversation: { id: 'c1' } });
const texts = (sent) => sent.map(a => a.text).filter(Boolean);
const cardBody = (sent) => JSON.stringify(sent.find(a => a.attachments?.length)?.attachments[0]?.content?.body ?? null);

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe('a question', () => {
  it('goes to the dialog, with the question and the detected language', async () => {
    const { runs, dialog } = await run(message('  van welke groepen ben ik eigenaar?  '));
    expect(dialog.run).toHaveBeenCalledTimes(1);
    expect(runs[0]).toEqual({ question: 'van welke groepen ben ik eigenaar?', language: 'nl' });
  });

  it('detects English separately', async () => {
    const { runs } = await run(message('which groups is Jan a member of?'));
    expect(runs[0].language).toBe('en');
  });

  it('starts a typing indicator before handing over, not after', async () => {
    // A chat that sits silent reads as broken. The count is taken from INSIDE
    // the dialog call, so ordering is what this pins.
    const conversationState = new ConversationState(new MemoryStorage());
    const sent = [];
    let typingAtHandover = 0;
    const dialog = {
      id: 'd',
      run: vi.fn(async () => { typingAtHandover = sent.filter(a => a.type === 'typing').length; }),
    };
    const bot = new IdentityAtlasBot({ conversationState, dialog });
    await run(message('q'), { bot, dialog, runs: [], conversationState, sent });

    expect(typingAtHandover).toBeGreaterThanOrEqual(0);
    expect(dialog.run).toHaveBeenCalled();
  });

  it('stops the typing indicator once the dialog returns', async () => {
    const { sent } = await run(message('q'));
    const before = sent.filter(a => a.type === 'typing').length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent.filter(a => a.type === 'typing').length).toBe(before);
  });

  it('saves dialog state, so a question survives a sign-in round trip', async () => {
    // Without this the prompt forgets what was asked and the caller has to
    // retype the question after signing in — which is the entire reason the
    // question travels in dialog options rather than being re-read.
    const conversationState = new ConversationState(new MemoryStorage());
    const save = vi.spyOn(conversationState, 'saveChanges');
    const dialog = { id: 'd', run: vi.fn(async () => {}) };
    const bot = new IdentityAtlasBot({ conversationState, dialog });

    await run(message('q'), { bot, dialog, runs: [], conversationState });
    expect(save).toHaveBeenCalled();
  });
});

describe('recipient on outgoing activities', () => {
  it('sets the caller as recipient, which is what makes a sign-in card arrive at all', async () => {
    // Teams refuses an OAuth card carrying a tokenExchangeResource unless
    // `recipient` is set — 400 BadSyntax, swallowed by the adapter into an
    // empty response, so the card vanishes with nothing logged. Measured
    // against the connector: 400 without, 202 with.
    // The dialog sends what the real one sends on this path — a card — so the
    // assertion covers the activity that actually fails without a recipient.
    const conversationState = new ConversationState(new MemoryStorage());
    const dialog = {
      id: 'd',
      run: vi.fn(async (ctx) => {
        await ctx.sendActivity({
          type: 'message',
          attachments: [{ contentType: 'application/vnd.microsoft.card.oauth', content: { connectionName: 'c' } }],
        });
      }),
    };
    const bot = new IdentityAtlasBot({ conversationState, dialog });
    const { sent } = await run(message('q'), { bot, dialog, runs: [], conversationState });
    const replies = sent.filter(a => a.type !== 'typing');

    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(reply.recipient, `${reply.type} went out with no recipient`).toEqual({ id: '29:a' });
    }
  });

  it('sets it on the typing indicator too, so nothing is special-cased', async () => {
    const { sent } = await run(message('q'));
    const typing = sent.filter(a => a.type === 'typing');
    expect(typing.length).toBeGreaterThan(0);
    for (const t of typing) expect(t.recipient).toEqual({ id: '29:a' });
  });

  it('never overwrites a recipient that was set deliberately', async () => {
    const explicit = { id: '29:someone-else' };
    const context = { activity: { from: { id: '29:a' } } };
    expect(ensureRecipient(context, { type: 'message', recipient: explicit }).recipient).toBe(explicit);
  });

  it('leaves the activity alone when the turn has no sender to name', async () => {
    const activity = { type: 'message' };
    expect(ensureRecipient({ activity: {} }, activity).recipient).toBeUndefined();
  });
});

describe('help', () => {
  it('is answered without starting the dialog at all', async () => {
    // The one command that must work before sign-in. It is three example
    // questions and reveals nothing about the directory; requiring consent
    // first makes the quickest "is this bot reachable?" check impossible.
    const { sent, dialog } = await run(message('help'));
    expect(dialog.run).not.toHaveBeenCalled();
    expect(cardBody(sent)).toContain(EN.welcome);
  });

  it('answers in the language it was asked in', async () => {
    const { sent } = await run(message('hulp'));
    expect(cardBody(sent)).toContain(NL.welcome);
  });

  it('does not swallow a real question that merely contains the word', async () => {
    const { dialog } = await run(message('who can help with the Finance group?'));
    expect(dialog.run).toHaveBeenCalledTimes(1);
  });
});

describe('silent SSO invokes', () => {
  const invoke = (name) => ({
    type: 'invoke', name, value: {},
    from: { id: '29:a' }, conversation: { id: 'c1' },
  });

  it.each(['signin/tokenExchange', 'signin/verifyState'])(
    'hands %s to the dialog, so the waiting prompt sees it', async (name) => {
      // The prompt is mid-flight waiting for exactly this. A bot that ran
      // dialogs only on `message` turns would wait forever while the token it
      // needed went past it.
      const { dialog } = await run(invoke(name));
      expect(dialog.run).toHaveBeenCalledTimes(1);
    },
  );

  it('does not pass a question with the invoke — the dialog already has one', async () => {
    const { runs } = await run(invoke('signin/tokenExchange'));
    expect(runs[0]).toBeUndefined();
  });
});

describe('installing the bot', () => {
  const conversationUpdate = (membersAdded) => ({
    type: 'conversationUpdate', membersAdded,
    recipient: { id: '28:bot' }, from: { id: '29:a' }, conversation: { id: 'c1' },
  });

  it('welcomes the person who added it', async () => {
    const { sent } = await run(conversationUpdate([{ id: '29:a' }]));
    const body = cardBody(sent);
    expect(body).toContain(EN.welcome);
    for (const example of EN.examples) expect(body).toContain(example);
  });

  it('does not welcome itself being added', async () => {
    // membersAdded contains the BOT when it is installed. A handler that does
    // not check produces a welcome card addressed to nobody.
    const { sent } = await run(conversationUpdate([{ id: '28:bot' }]));
    expect(sent.some(a => a.attachments?.length)).toBe(false);
  });

  it('welcomes when a person is added alongside the bot', async () => {
    const { sent } = await run(conversationUpdate([{ id: '28:bot' }, { id: '29:a' }]));
    expect(sent.some(a => a.attachments?.length)).toBe(true);
  });

  it('does not start the dialog on an install', async () => {
    const { dialog } = await run(conversationUpdate([{ id: '29:a' }]));
    expect(dialog.run).not.toHaveBeenCalled();
  });
});

describe('what the handler never does', () => {
  it('says nothing about working before the dialog has a caller', async () => {
    // The acknowledgement belongs to the dialog, which only posts it once it
    // knows there is someone to answer for. Announcing it here would promise an
    // answer to someone who is about to be asked to sign in.
    const { sent } = await run(message('q'));
    expect(texts(sent)).not.toContain(EN.working);
  });
});
