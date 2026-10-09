// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useOrgLinked, { loadOrgLinked } from '@ui/components/orgtruth/useOrgLinked';
import { makeAuthFetch, jsonResponse } from '@ui/test-utils/renderWithProviders';

const PAYLOAD = { total: 1, groups: [{ key: 'g', label: 'Klant · eigenaar', count: 1, items: [] }] };
const URL = '/api/org-truth/linked/Principal/p1';

describe('loadOrgLinked', () => {
  it('fetches once per url and authFetch, then answers from the cache', async () => {
    const authFetch = makeAuthFetch({ [URL]: PAYLOAD });
    expect(await loadOrgLinked(URL, authFetch)).toEqual(PAYLOAD);
    expect(await loadOrgLinked(URL, authFetch)).toEqual(PAYLOAD);
    expect(authFetch).toHaveBeenCalledTimes(1);
    // A different authFetch (another sign-in) asks again.
    const other = makeAuthFetch({ [URL]: PAYLOAD });
    await loadOrgLinked(URL, other);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['404 (feature off)', jsonResponse({ error: 'off' }, { ok: false, status: 404 })],
    ['501', jsonResponse({ error: 'not built' }, { ok: false, status: 501 })],
    ['a payload without groups', { total: 3 }],
  ])('answers null on %s and does not cache it', async (_name, response) => {
    const authFetch = makeAuthFetch({ [URL]: response });
    expect(await loadOrgLinked(URL, authFetch)).toBeNull();
    expect(await loadOrgLinked(URL, authFetch)).toBeNull();
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it('answers null when the request throws', async () => {
    const authFetch = vi.fn(async () => { throw new Error('network'); });
    expect(await loadOrgLinked(URL, authFetch)).toBeNull();
  });
});

describe('useOrgLinked', () => {
  it('is null until the payload arrives, then returns it', async () => {
    const authFetch = makeAuthFetch({ [URL]: PAYLOAD });
    const { result } = renderHook(() => useOrgLinked('user', 'p1', authFetch));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual(PAYLOAD));
    expect(authFetch).toHaveBeenCalledWith(URL);
  });

  it('does not fetch for a kind without an Organisation node', async () => {
    const authFetch = makeAuthFetch({});
    const { result } = renderHook(() => useOrgLinked('access-package', 'ap1', authFetch));
    await Promise.resolve();
    expect(result.current).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('does not fetch without an authFetch', () => {
    const { result } = renderHook(() => useOrgLinked('user', 'p1', undefined));
    expect(result.current).toBeNull();
  });

  it('drops the previous entity payload when the id changes', async () => {
    const authFetch = makeAuthFetch({ [URL]: PAYLOAD, '/Principal/p2': jsonResponse({}, { ok: false, status: 404 }) });
    const { result, rerender } = renderHook(({ id }) => useOrgLinked('user', id, authFetch), { initialProps: { id: 'p1' } });
    await waitFor(() => expect(result.current).toEqual(PAYLOAD));
    rerender({ id: 'p2' });
    expect(result.current).toBeNull();
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/linked/Principal/p2'));
    expect(result.current).toBeNull();
  });
});
