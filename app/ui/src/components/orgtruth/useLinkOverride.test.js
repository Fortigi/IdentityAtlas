// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { jsonResponse, makeAuthFetch, makeWrapper, renderHook, screen, waitFor, act } from '@ui/test-utils/renderWithProviders';
import { useLinkOverride } from './useLinkOverride';

function setup(handler) {
  const authFetch = makeAuthFetch(handler);
  const onDone = vi.fn();
  const { wrapper } = makeWrapper();
  const { result } = renderHook(() => useLinkOverride({ authFetch, onDone }), { wrapper });
  return { result, authFetch, onDone };
}

describe('useLinkOverride', () => {
  it('PUTs a confirm, toasts and calls onDone', async () => {
    const { result, authFetch, onDone } = setup({ '/override': { ok: true } });
    let ok;
    await act(async () => { ok = await result.current.override('l/1', 'confirmed'); });
    expect(ok).toBe(true);
    expect(authFetch).toHaveBeenCalledWith('/api/org-truth/links/l%2F1/override', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirmed' }),
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBeNull();
    await waitFor(() => expect(screen.getByText('Link confirmed')).toBeInTheDocument());
  });

  it('sends the target of a move and DELETEs for clear', async () => {
    const { result, authFetch } = setup({ '/override': { ok: true } });
    await act(() => result.current.override('l1', 'moved', 'u2'));
    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({ action: 'moved', targetId: 'u2' });
    await act(() => result.current.override('l1', 'clear'));
    expect(authFetch.mock.calls[1]).toEqual(['/api/org-truth/links/l1/override', { method: 'DELETE' }]);
    await waitFor(() => expect(screen.getByText('Decision undone')).toBeInTheDocument());
  });

  it('keeps the server sentence on failure and does not call onDone', async () => {
    const { result, onDone } = setup({ '/override': jsonResponse({ error: 'Unknown action' }, { ok: false, status: 400 }) });
    let ok;
    await act(async () => { ok = await result.current.override('l1', 'bogus'); });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('The decision was not saved: Unknown action');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('says "not available yet" on 501 and gives the status without a body', async () => {
    const r501 = setup({ '/override': jsonResponse({}, { ok: false, status: 501 }) });
    await act(() => r501.result.current.override('l1', 'rejected'));
    expect(r501.result.current.error).toBe('Reviewing links is not available yet.');

    const bad = { ok: false, status: 500, json: async () => { throw new Error('no body'); } };
    const r500 = setup(() => bad);
    await act(() => r500.result.current.override('l1', 'rejected'));
    expect(r500.result.current.error).toBe('The decision was not saved (HTTP 500).');
  });

  it('reports a network failure', async () => {
    const { result } = setup(() => { throw new Error('offline'); });
    await act(() => result.current.override('l1', 'confirmed'));
    expect(result.current.error).toBe('The decision was not saved: offline');
  });
});
