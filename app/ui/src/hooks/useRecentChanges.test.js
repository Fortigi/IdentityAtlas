// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@ui/test-utils/renderWithProviders';
import useRecentChanges from './useRecentChanges';

const res = (body, ok = true) => ({ ok, json: async () => body });

describe('useRecentChanges', () => {
  it('fetches and derives added/removed subsets + addedIds', async () => {
    const events = [
      { operation: 'added', counterpartyId: 'a' },
      { operation: 'removed', counterpartyId: 'b' },
      { operation: 'changed', counterpartyId: 'c' },
    ];
    const authFetch = vi.fn().mockResolvedValue(res({ events, sinceDays: 30 }));
    const { result } = renderHook(() => useRecentChanges('user', 'u1', authFetch));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events).toHaveLength(3);
    expect(result.current.added).toHaveLength(1);
    expect(result.current.removed).toHaveLength(1);
    expect(result.current.addedCount).toBe(1);
    expect(result.current.removedCount).toBe(1);
    expect(result.current.addedIds.has('a')).toBe(true);
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/user/u1/recent-changes'));
  });

  it('does not fetch for a missing entity or unknown kind', () => {
    const authFetch = vi.fn();
    renderHook(() => useRecentChanges('user', null, authFetch));
    renderHook(() => useRecentChanges('bogus', 'x', authFetch));
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('returns empty derived defaults on a non-ok response', async () => {
    const authFetch = vi.fn().mockResolvedValue(res({}, false));
    const { result } = renderHook(() => useRecentChanges('resource', 'r1', authFetch));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events).toEqual([]);
    expect(result.current.addedIds.size).toBe(0);
  });
});
