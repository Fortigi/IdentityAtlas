// @vitest-environment jsdom
//
// The one action behind every admin feature-flag switch. What has to hold:
// the right feature name and value reach the API, a success reloads the page
// (nothing else makes already-mounted tabs re-read the flag), and a failure
// reloads nothing and surfaces a message the operator can act on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, makeWrapper, jsonResponse, makeAuthFetch } from '@ui/test-utils/renderWithProviders';
import useFeatureToggle from './useFeatureToggle';

let reload;
let realLocation;
beforeEach(() => {
  realLocation = window.location;
  reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

function setup(response) {
  const authFetch = makeAuthFetch(() => response ?? {});
  const { wrapper } = makeWrapper({ auth: { authFetch } });
  const { result } = renderHook(() => useFeatureToggle('experimentalCrawlers'), { wrapper });
  return { result, authFetch };
}

describe('useFeatureToggle', () => {
  it('starts idle, with nothing in flight and no error', () => {
    const { result } = setup();
    expect(result.current.toggling).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('posts the feature name it was built with, and the value it was asked for', async () => {
    const { result, authFetch } = setup();
    await act(() => result.current.toggle(true));
    const [url, opts] = authFetch.mock.calls[0];
    expect(url).toBe('/api/admin/features/toggle');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ feature: 'experimentalCrawlers', enabled: true });
  });

  it('passes enabled:false straight through — it does not invent the new value itself', async () => {
    const { result, authFetch } = setup();
    await act(() => result.current.toggle(false));
    expect(JSON.parse(authFetch.mock.calls[0][1].body).enabled).toBe(false);
  });

  it('reloads the page on success', async () => {
    const { result } = setup();
    await act(() => result.current.toggle(true));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('surfaces the API error message and leaves the page alone', async () => {
    const { result } = setup(jsonResponse({ error: 'SQL not configured' }, { ok: false, status: 503 }));
    await act(() => result.current.toggle(true));
    expect(result.current.error).toBe('SQL not configured');
    expect(reload).not.toHaveBeenCalled();
    // Not stuck mid-flight: the switch has to become clickable again.
    expect(result.current.toggling).toBe(false);
  });

  it('falls back to the status code when the failure carries no message', async () => {
    const { result } = setup(jsonResponse('not json at all', { ok: false, status: 500 }));
    await act(() => result.current.toggle(true));
    expect(result.current.error).toBe('HTTP 500');
  });

  it('reports a network failure rather than swallowing it', async () => {
    const authFetch = vi.fn(async () => { throw new Error('Failed to fetch'); });
    const { wrapper } = makeWrapper({ auth: { authFetch } });
    const { result } = renderHook(() => useFeatureToggle('riskScoring'), { wrapper });
    await act(() => result.current.toggle(true));
    expect(result.current.error).toBe('Failed to fetch');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reports itself in flight while the request is open, and idle again after', async () => {
    // Without this the switch would never disable, and a double-click would
    // post the same flip twice.
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const authFetch = vi.fn(() => pending);
    const { wrapper } = makeWrapper({ auth: { authFetch } });
    const { result } = renderHook(() => useFeatureToggle('experimentalCrawlers'), { wrapper });

    let done;
    act(() => { done = result.current.toggle(true); });
    await waitFor(() => expect(result.current.toggling).toBe(true));

    await act(async () => { release(jsonResponse({})); await done; });
    expect(reload).toHaveBeenCalled();
  });

  it('clears the previous error when the next attempt starts', async () => {
    let response = jsonResponse({ error: 'SQL not configured' }, { ok: false, status: 503 });
    const authFetch = vi.fn(async () => response);
    const { wrapper } = makeWrapper({ auth: { authFetch } });
    const { result } = renderHook(() => useFeatureToggle('experimentalCrawlers'), { wrapper });

    await act(() => result.current.toggle(true));
    expect(result.current.error).toBe('SQL not configured');

    response = jsonResponse({});
    await act(() => result.current.toggle(true));
    expect(result.current.error).toBeNull();
  });

  it('still reports the status code when the error body is not JSON at all', async () => {
    const authFetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    }));
    const { wrapper } = makeWrapper({ auth: { authFetch } });
    const { result } = renderHook(() => useFeatureToggle('experimentalCrawlers'), { wrapper });
    await act(() => result.current.toggle(true));
    expect(result.current.error).toBe('HTTP 502');
  });

  it('follows the feature it is given when the caller switches flags', async () => {
    const authFetch = makeAuthFetch(() => ({}));
    const { wrapper } = makeWrapper({ auth: { authFetch } });
    const { result, rerender } = renderHook(
      ({ feature }) => useFeatureToggle(feature),
      { wrapper, initialProps: { feature: 'experimentalCrawlers' } },
    );
    await act(() => result.current.toggle(true));
    expect(JSON.parse(authFetch.mock.calls[0][1].body).feature).toBe('experimentalCrawlers');

    rerender({ feature: 'riskScoring' });
    await act(() => result.current.toggle(false));
    expect(JSON.parse(authFetch.mock.calls[1][1].body).feature).toBe('riskScoring');
  });
});
