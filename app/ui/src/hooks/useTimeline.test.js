// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@ui/test-utils/renderWithProviders';
import useTimeline from './useTimeline';

const res = (body, ok = true) => ({ ok, json: async () => body });

describe('useTimeline', () => {
  it('fetches the timeline and exposes events + counts', async () => {
    const authFetch = vi.fn().mockResolvedValue(
      res({ events: [{ id: 1 }], addedCount: 2, removedCount: 1, changedCount: 3, sinceDays: 90 }),
    );
    const { result } = renderHook(() => useTimeline('user', 'u1', authFetch));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events).toEqual([{ id: 1 }]);
    expect(result.current.addedCount).toBe(2);
    expect(result.current.changedCount).toBe(3);
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/user/u1/timeline'));
  });

  it('does not fetch when disabled (tab not open)', () => {
    const authFetch = vi.fn();
    renderHook(() => useTimeline('user', 'u1', authFetch, { enabled: false }));
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('does not fetch for an unknown entity kind or missing id', () => {
    const authFetch = vi.fn();
    renderHook(() => useTimeline('nope', 'x', authFetch));
    renderHook(() => useTimeline('user', null, authFetch));
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('falls back to an empty timeline on a non-ok response', async () => {
    const authFetch = vi.fn().mockResolvedValue(res({}, false));
    const { result } = renderHook(() => useTimeline('context', 'c1', authFetch, { sinceDays: 45 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events).toEqual([]);
    expect(result.current.sinceDays).toBe(45);
  });
});
