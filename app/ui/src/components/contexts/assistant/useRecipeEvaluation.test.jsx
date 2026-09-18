// @vitest-environment jsdom
//
// The draft is evaluated on the server a moment after the analyst stops changing it.
// What matters: it waits, it does not ask for a draft that cannot search anything, a
// rename does not re-ask, and an answer for an older draft never lands.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeAuthFetch, renderHook, act } from '@ui/test-utils/renderWithProviders';
import { EVALUATE_DELAY_MS, hasSearch, useRecipeEvaluation } from './useRecipeEvaluation';

const RECIPE = { name: 'Inkoop', terms: [{ text: 'inkoop', key: 'inkoop' }], include: [], exclude: [], fields: ['displayName'] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(EVALUATE_DELAY_MS + 1); }); };

describe('hasSearch', () => {
  it('is false only when there is nothing to search for and nothing pinned', () => {
    expect(hasSearch({ terms: [], include: [] })).toBe(false);
    expect(hasSearch({ terms: [{ text: 'a' }], include: [] })).toBe(true);
    expect(hasSearch({ terms: [], include: ['id'] })).toBe(true);
  });
});

describe('useRecipeEvaluation', () => {
  it('waits before asking, then reports what the server found', async () => {
    const authFetch = makeAuthFetch({ '/evaluate': { memberCount: 3, terms: [], matches: [] } });
    const { result } = renderHook(() => useRecipeEvaluation(authFetch, RECIPE));

    expect(authFetch).not.toHaveBeenCalled();
    expect(result.current.evaluating).toBe(true);
    await settle();
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ evaluating: false, error: null });
    expect(result.current.evaluation.memberCount).toBe(3);
  });

  it('never asks for a draft with no terms and nothing pinned', async () => {
    const authFetch = makeAuthFetch({ '/evaluate': { memberCount: 0 } });
    const { result } = renderHook(() => useRecipeEvaluation(authFetch, { ...RECIPE, terms: [] }));
    await settle();
    expect(authFetch).not.toHaveBeenCalled();
    expect(result.current).toEqual({ evaluation: null, evaluating: false, error: null });
  });

  it('does not ask again when only the name changed — renaming changes nothing about what matches', async () => {
    const authFetch = makeAuthFetch({ '/evaluate': { memberCount: 3 } });
    const { rerender } = renderHook(({ recipe }) => useRecipeEvaluation(authFetch, recipe), { initialProps: { recipe: RECIPE } });
    await settle();
    rerender({ recipe: { ...RECIPE, name: 'Inkoopproces' } });
    await settle();
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it('asks once for a burst of edits, and shows the answer for the newest draft', async () => {
    const answers = { 1: { memberCount: 1 }, 2: { memberCount: 2 } };
    let asked = 0;
    const authFetch = makeAuthFetch(async (_url, opts) => answers[JSON.parse(opts.body).recipe.terms.length] ?? (asked += 1));
    const two = { ...RECIPE, terms: [...RECIPE.terms, { text: 'coupa', key: 'coupa' }] };
    const { result, rerender } = renderHook(({ recipe }) => useRecipeEvaluation(authFetch, recipe), { initialProps: { recipe: RECIPE } });

    await act(async () => { await vi.advanceTimersByTimeAsync(EVALUATE_DELAY_MS - 50); });
    rerender({ recipe: two });               // changed again before the first request went out
    await settle();

    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(result.current.evaluation.memberCount).toBe(2);
  });

  it('keeps "evaluating" while the answer belongs to an older draft', async () => {
    const authFetch = makeAuthFetch({ '/evaluate': { memberCount: 1 } });
    const { result, rerender } = renderHook(({ recipe }) => useRecipeEvaluation(authFetch, recipe), { initialProps: { recipe: RECIPE } });
    await settle();
    expect(result.current.evaluating).toBe(false);

    rerender({ recipe: { ...RECIPE, terms: [...RECIPE.terms, { text: 'coupa', key: 'coupa' }] } });
    expect(result.current.evaluating).toBe(true);     // the shown numbers are stale, and say so
    await settle();
    expect(result.current.evaluating).toBe(false);
  });

  it('shows a failure without wiping the last answer', async () => {
    let fail = false;
    const authFetch = makeAuthFetch(async () => (fail
      ? new Response(JSON.stringify({ error: 'Request failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      : { memberCount: 3 }));
    const { result, rerender } = renderHook(({ recipe }) => useRecipeEvaluation(authFetch, recipe), { initialProps: { recipe: RECIPE } });
    await settle();

    fail = true;
    rerender({ recipe: { ...RECIPE, terms: [...RECIPE.terms, { text: 'coupa', key: 'coupa' }] } });
    await settle();

    expect(result.current.error).toBe('Request failed');
    expect(result.current.evaluation.memberCount).toBe(3);
  });
});
