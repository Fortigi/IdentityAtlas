// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { makeAuthFetch, jsonResponse, renderHook, act } from '@ui/test-utils/renderWithProviders';
import { MAX_HISTORY, useTermConversation } from './useTermConversation';

const TERMS = { kind: 'terms', name: 'Inkoop', terms: [{ text: 'inkoop', state: 'accepted' }], notes: [], raw: '{"kind":"terms"}' };
const CLARIFY = { kind: 'clarify', question: 'Which subject?', options: ['A process'], raw: '{"kind":"clarify"}' };
const RECIPE = { terms: [{ text: 'inkoop', key: 'inkoop', state: 'accepted' }] };

function setup(handler, { onTerms = vi.fn(), initialQuestion = '' } = {}) {
  const authFetch = makeAuthFetch(handler);
  const hook = renderHook(() => useTermConversation({ authFetch, recipe: RECIPE, onTerms, initialQuestion }));
  return { hook, authFetch, onTerms };
}

describe('useTermConversation', () => {
  it('asks, shows both sides of the turn, and hands the terms to the builder', async () => {
    const { hook, authFetch, onTerms } = setup({ '/interpret': TERMS });
    await act(() => hook.result.current.ask('  inkoopgroepen  '));

    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({ question: 'inkoopgroepen', history: [] });
    expect(hook.result.current.turns).toEqual([
      { role: 'user', text: 'inkoopgroepen' },
      { role: 'assistant', reply: TERMS },
    ]);
    expect(onTerms).toHaveBeenCalledWith(TERMS);
    expect(hook.result.current.question).toBe('inkoopgroepen');
    expect(hook.result.current.input).toBe('');
  });

  it('sends the earlier turns back so an answer to a clarifying question has its context', async () => {
    const { hook, authFetch } = setup({ '/interpret': CLARIFY });
    await act(() => hook.result.current.ask('the important groups'));
    expect(hook.result.current.awaitingAnswer).toBe(true);

    await act(() => hook.result.current.ask('purchasing'));
    expect(JSON.parse(authFetch.mock.calls[1][1].body).history).toEqual([
      { role: 'user', content: 'the important groups' },
      { role: 'assistant', content: CLARIFY.raw },
    ]);
    // Both are the analyst's own words, so "suggest more" refers to the whole request.
    expect(hook.result.current.question).toBe('the important groups — purchasing');
  });

  it('keeps the conversation it sends within MAX_HISTORY turns', async () => {
    const { hook, authFetch } = setup({ '/interpret': CLARIFY });
    for (let i = 0; i < MAX_HISTORY; i++) {
      await act(() => hook.result.current.ask(`q${i}`));
    }
    const sent = JSON.parse(authFetch.mock.calls.at(-1)[1].body).history;
    expect(sent).toHaveLength(MAX_HISTORY);
    expect(sent.at(-1)).toEqual({ role: 'assistant', content: CLARIFY.raw });
  });

  it('asks for more terms against the draft, and does nothing without a description', async () => {
    const { hook, authFetch, onTerms } = setup({ '/suggest': TERMS });
    await act(() => hook.result.current.suggestMore());
    expect(authFetch).not.toHaveBeenCalled();     // nothing described yet

    const withQuestion = setup({ '/suggest': TERMS }, { initialQuestion: 'inkoopgroepen' });
    await act(() => withQuestion.hook.result.current.suggestMore());
    expect(JSON.parse(withQuestion.authFetch.mock.calls[0][1].body)).toEqual({ question: 'inkoopgroepen', recipe: RECIPE });
    expect(withQuestion.onTerms).toHaveBeenCalledWith(TERMS);
    expect(onTerms).not.toHaveBeenCalled();
  });

  it('ignores an empty question and shows what a failed request said', async () => {
    const { hook, authFetch } = setup({ '/interpret': jsonResponse({ error: 'The local model server is not reachable or failed.' }, { ok: false, status: 502 }) });
    await act(() => hook.result.current.ask('   '));
    expect(authFetch).not.toHaveBeenCalled();

    await act(() => hook.result.current.ask('inkoop'));
    expect(hook.result.current.error).toBe('The local model server is not reachable or failed.');
    expect(hook.result.current.busy).toBe(false);
  });
});
