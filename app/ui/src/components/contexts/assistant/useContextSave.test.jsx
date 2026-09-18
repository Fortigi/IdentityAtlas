// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { makeAuthFetch, jsonResponse, renderHook, act } from '@ui/test-utils/renderWithProviders';
import { savedMessage, useContextSave } from './useContextSave';

const RECIPE = { name: 'Inkoop', terms: [{ text: 'inkoop' }] };

function setup(handler, initialContextId = null) {
  const authFetch = makeAuthFetch(handler);
  const onSaved = vi.fn();
  return { hook: renderHook(() => useContextSave({ authFetch, initialContextId, onSaved })), authFetch, onSaved };
}

describe('savedMessage', () => {
  it('says what the run did', () => {
    expect(savedMessage({ membersAdded: 12 }, true)).toBe('Created — 12 objects added.');
    expect(savedMessage({ membersAdded: 2, membersRemoved: 1 }, false)).toBe('Saved — 2 added, 1 removed.');
    expect(savedMessage({ membersAdded: 0, membersRemoved: 0 }, false)).toBe('Saved — no change in membership.');
  });
});

describe('useContextSave', () => {
  it('creates the tree, then refreshes that same tree on the next save', async () => {
    const { hook, authFetch, onSaved } = setup({ '/save': { runId: 'r1', contextId: 'ctx-1', membersAdded: 12, membersRemoved: 0 } });

    await act(() => hook.result.current.save(RECIPE, 'inkoopgroepen'));
    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({ recipe: RECIPE, question: 'inkoopgroepen' });
    expect(hook.result.current.contextId).toBe('ctx-1');
    expect(hook.result.current.message).toEqual({ kind: 'ok', text: 'Created — 12 objects added.' });
    expect(onSaved).toHaveBeenCalledWith('ctx-1', 'Inkoop');

    await act(() => hook.result.current.save(RECIPE, 'inkoopgroepen'));
    expect(JSON.parse(authFetch.mock.calls[1][1].body).contextId).toBe('ctx-1');
    expect(hook.result.current.message.text).toBe('Saved — 12 added, 0 removed.');
  });

  it('refreshes the tree it was opened on', async () => {
    const { hook, authFetch } = setup({ '/save': { runId: 'r2', contextId: 'ctx-9', membersAdded: 0, membersRemoved: 3 } }, 'ctx-9');
    await act(() => hook.result.current.save(RECIPE, ''));
    expect(JSON.parse(authFetch.mock.calls[0][1].body).contextId).toBe('ctx-9');
    expect(hook.result.current.message.text).toBe('Saved — 0 added, 3 removed.');
  });

  it('shows why a save failed, including what the run reported, and stays saveable', async () => {
    const { hook, onSaved } = setup({ '/save': jsonResponse({ error: 'Building the context failed', detail: 'statement timeout' }, { ok: false, status: 500 }) });
    await act(() => hook.result.current.save(RECIPE, ''));
    expect(hook.result.current.message).toEqual({ kind: 'error', text: 'Building the context failed (statement timeout)' });
    expect(hook.result.current.saving).toBe(false);
    expect(hook.result.current.contextId).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('lists what a refused recipe complained about', async () => {
    const { hook } = setup({ '/save': jsonResponse({ error: 'The context cannot be saved', errors: ['Give the context a name.'] }, { ok: false, status: 400 }) });
    await act(() => hook.result.current.save({ ...RECIPE, name: '' }, ''));
    expect(hook.result.current.message.text).toContain('Give the context a name.');
  });
});
