// @vitest-environment jsdom
//
// The conversation hook — what this pins down (beyond the assistant's mount test):
//   • a /resolve that needs another choice asks again instead of reporting, and
//     the second choice reports under the ORIGINAL question
//   • a failed /resolve is shown and nothing is reported
//   • an empty question and a question asked while busy send nothing
//   • the history sent to the model is capped to the last MAX_HISTORY messages
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MAX_HISTORY, specContext, useAskConversation } from './useAskConversation';

const json = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

function setup(handler) {
  const authFetch = vi.fn((url, opts) => handler(String(url), opts.body ? JSON.parse(opts.body) : undefined));
  const onReport = vi.fn();
  const hook = renderHook(() => useAskConversation({ authFetch, currentSpec: null, onReport }));
  return { ...hook, authFetch, onReport };
}

describe('useAskConversation', () => {
  it('asks again when the resolved definition needs another choice, then reports under the original question', async () => {
    const second = { kind: 'value', path: [1], message: 'Which department?', choices: [] };
    let resolves = 0;
    const { result, onReport } = setup((url) => {
      if (url.includes('interpret')) return json({ kind: 'confirm', spec: { v: 0 }, confirm: { path: [0] }, raw: 'r' });
      resolves += 1;
      return json(resolves === 1 ? { spec: { v: 1 }, confirm: second } : { spec: { v: 2 }, explanation: 'done' });
    });

    await act(() => result.current.ask('members of sales'));
    const confirmReply = result.current.turns[1].reply;
    await act(() => result.current.confirmChoice(confirmReply, { name: 'Sales role' }));

    expect(onReport).not.toHaveBeenCalled();
    const again = result.current.turns.at(-1).reply;
    expect(again).toMatchObject({ kind: 'confirm', confirm: second, spec: { v: 1 }, timing: null });

    await act(() => result.current.confirmChoice(again, { name: 'Sales EMEA' }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ kind: 'report', spec: { v: 2 }, explanation: 'done' }), 'members of sales');
    expect(result.current.turns.filter(t => t.reply?.kind === 'chosen').map(t => t.reply.name)).toEqual(['Sales role', 'Sales EMEA']);
  });

  it('shows a failed resolve and reports nothing', async () => {
    const { result, onReport } = setup(() => json({ error: 'Record vanished' }, false, 404));
    await act(() => result.current.confirmChoice({ kind: 'confirm', spec: {} }, { name: 'x' }));
    expect(result.current.error).toBe('Record vanished');
    expect(result.current.busy).toBe(false);
    expect(onReport).not.toHaveBeenCalled();
  });

  it('sends nothing for a blank question', async () => {
    const { result, authFetch } = setup(() => json({ kind: 'report' }));
    await act(() => result.current.ask('   '));
    expect(authFetch).not.toHaveBeenCalled();
    expect(result.current.turns).toEqual([]);
  });

  it('sends nothing while a question is still being answered', async () => {
    let release;
    const { result, authFetch } = setup(() => new Promise((r) => { release = () => r({ ok: true, status: 200, json: () => Promise.resolve({ kind: 'clarify', raw: '' }) }); }));
    act(() => { result.current.ask('first'); });
    await waitFor(() => expect(result.current.busy).toBe(true));
    await act(() => result.current.ask('second'));
    expect(authFetch).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it('keeps only the last MAX_HISTORY messages of history', async () => {
    const { result, authFetch } = setup((url, body) => json({ kind: 'clarify', raw: `re ${body.question}` }));
    for (let i = 0; i < 7; i += 1) {
      await act(() => result.current.ask(`q${i}`));
    }
    const lastBody = JSON.parse(authFetch.mock.calls.at(-1)[1].body);
    expect(lastBody.history).toHaveLength(MAX_HISTORY);
    // 6 earlier exchanges = 12 messages; the first exchange fell off.
    expect(lastBody.history[0]).toEqual({ role: 'user', content: 'q1' });
    expect(lastBody.history.at(-1)).toEqual({ role: 'assistant', content: 're q5' });
    expect(result.current.awaitingAnswer).toBe(true);
  });

  it('sends no definition context when the builder is empty', () => {
    expect(specContext(null)).toEqual([]);
  });
});

describe('the conversation thread', () => {
  it('sends the same conversation id with every question of one chat', async () => {
    const bodies = [];
    const { result } = setup((url, body) => {
      bodies.push(body);
      return json({ kind: 'clarify', question: 'Which?', raw: 'r' });
    });
    await act(() => result.current.ask('first'));
    await act(() => result.current.ask('second'));

    expect(bodies).toHaveLength(2);
    expect(bodies[0].conversationId).toMatch(/^[A-Za-z0-9:_-]{1,100}$/);
    expect(bodies[1].conversationId).toBe(bodies[0].conversationId);
    expect(result.current.conversationId).toBe(bodies[0].conversationId);
  });

  it('starts a new conversation with a fresh id and nothing on screen', async () => {
    const bodies = [];
    const { result } = setup((url, body) => { bodies.push(body); return json({ kind: 'clarify', question: 'Which?', raw: 'r' }); });
    await act(() => result.current.ask('first'));
    const before = result.current.conversationId;

    act(() => result.current.newConversation());
    expect(result.current.turns).toEqual([]);
    expect(result.current.conversationId).not.toBe(before);

    await act(() => result.current.ask('again'));
    expect(bodies[1].conversationId).toBe(result.current.conversationId);
    // The model is not sent the old chat's history either.
    expect(bodies[1].history).toEqual([]);
  });
});
