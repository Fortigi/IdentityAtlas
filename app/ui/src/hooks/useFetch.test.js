// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@ui/test-utils/renderWithProviders';
import { useFetch } from './useFetch';

const res = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

describe('useFetch', () => {
  it('starts loading then resolves with data', async () => {
    const authFetch = vi.fn().mockResolvedValue(res({ hello: 'world' }));
    const { result } = renderHook(() => useFetch('/api/x', { authFetch }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ hello: 'world' });
    expect(result.current.error).toBeNull();
  });

  it('sets an Error on a non-ok response', async () => {
    const authFetch = vi.fn().mockResolvedValue(res({}, { ok: false, status: 500 }));
    const { result } = renderHook(() => useFetch('/api/x', { authFetch }));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error.message).toMatch(/500/);
    expect(result.current.loading).toBe(false);
  });

  it('skips the request when disabled', () => {
    const authFetch = vi.fn();
    const { result } = renderHook(() => useFetch('/api/x', { authFetch, enabled: false }));
    expect(authFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('skips the request when url is falsy', () => {
    const authFetch = vi.fn();
    renderHook(() => useFetch(null, { authFetch }));
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('applies transform to the parsed JSON', async () => {
    const authFetch = vi.fn().mockResolvedValue(res({ items: [1, 2, 3] }));
    const { result } = renderHook(() => useFetch('/api/x', { authFetch, transform: (d) => d.items }));
    await waitFor(() => expect(result.current.data).toEqual([1, 2, 3]));
  });

  it('re-fetches on reload()', async () => {
    const authFetch = vi.fn().mockResolvedValue(res({ n: 1 }));
    const { result } = renderHook(() => useFetch('/api/x', { authFetch }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(authFetch).toHaveBeenCalledTimes(1);
    act(() => result.current.reload());
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
  });

  it('re-fetches when the url changes', async () => {
    const authFetch = vi.fn().mockResolvedValue(res({ ok: true }));
    const { rerender } = renderHook(({ url }) => useFetch(url, { authFetch }), { initialProps: { url: '/api/a' } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/a'));
    rerender({ url: '/api/b' });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/b'));
  });

  it('calls onError on failure', async () => {
    const onError = vi.fn();
    const authFetch = vi.fn().mockResolvedValue(res({}, { ok: false, status: 404 }));
    renderHook(() => useFetch('/api/x', { authFetch, onError }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });
});
