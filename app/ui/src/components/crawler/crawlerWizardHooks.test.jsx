// @vitest-environment jsdom
//
// The three hooks behind every crawler wizard. Each owns one decision that a
// wizard would otherwise get subtly wrong on its own:
//   useCredentialFields  — secrets start blank even when editing
//   useCrawlerSave       — a failed save reports why and does NOT call onComplete
//   useCrawlerDiscovery  — discovery is an assist: it degrades, never blocks
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor, makeWrapper } from '@ui/test-utils/renderWithProviders';
import useCredentialFields from './useCredentialFields';
import useCrawlerSave from './useCrawlerSave';
import useCrawlerDiscovery from './useCrawlerDiscovery';

const { wrapper } = makeWrapper();

describe('useCredentialFields', () => {
  it('seeds the non-secret fields from a saved config', () => {
    const { result } = renderHook(
      () => useCredentialFields({ username: 'svc', clientId: 'cid', tokenEndpoint: 'https://t' }),
      { wrapper });
    expect(result.current.creds.username).toBe('svc');
    expect(result.current.creds.clientId).toBe('cid');
    expect(result.current.creds.tokenEndpoint).toBe('https://t');
  });

  it('starts every SECRET blank even when the saved config carries one', () => {
    // A vaulted secret never reaches the browser; a blank means "keep it". If
    // this ever seeded, an edit would post back whatever was rendered.
    const { result } = renderHook(
      () => useCredentialFields({ password: 'leaked', clientSecret: 'leaked', apiToken: 'leaked', cookieString: 'leaked' }),
      { wrapper });
    expect(result.current.creds.password).toBe('');
    expect(result.current.creds.clientSecret).toBe('');
    expect(result.current.creds.apiToken).toBe('');
    expect(result.current.creds.cookieString).toBe('');
  });

  it('defaults every field to a string when there is no saved config', () => {
    const { result } = renderHook(() => useCredentialFields(undefined), { wrapper });
    for (const v of Object.values(result.current.creds)) expect(v).toBe('');
  });

  it('setCred changes one field and leaves the rest alone', () => {
    const { result } = renderHook(() => useCredentialFields({ username: 'svc' }), { wrapper });
    act(() => result.current.setCred('password', 'pw'));
    expect(result.current.creds.password).toBe('pw');
    expect(result.current.creds.username).toBe('svc');
  });
});

describe('useCrawlerSave', () => {
  const setup = (authFetch, onComplete = vi.fn()) => {
    const { result } = renderHook(
      () => useCrawlerSave({ authFetch, crawlerType: 'scim', configId: undefined, onComplete }),
      { wrapper });
    return { result, onComplete };
  };

  it('calls onComplete after a successful save and reports no error', async () => {
    const authFetch = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }) }));
    const { result, onComplete } = setup(authFetch);
    await act(() => result.current.save('Name', { a: 1 }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it('surfaces the failure message and does NOT call onComplete', async () => {
    // onComplete closes the wizard; firing it on a failed save would look like
    // the crawler saved when nothing was written.
    const authFetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'refused' }) }));
    const { result, onComplete } = setup(authFetch);
    await act(() => result.current.save('Name', {}));
    expect(result.current.error).toBe('refused');
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.current.saving).toBe(false);
  });

  it('clears a previous error when the next attempt starts', async () => {
    let response = { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    const authFetch = vi.fn(async () => response);
    const { result } = setup(authFetch);
    await act(() => result.current.save('Name', {}));
    expect(result.current.error).toBe('boom');

    response = { ok: true, status: 201, json: async () => ({}) };
    await act(() => result.current.save('Name', {}));
    expect(result.current.error).toBeNull();
  });
});

describe('useCrawlerDiscovery', () => {
  const EMPTY = { things: [] };
  const setup = (authFetch, configId) => renderHook(
    () => useCrawlerDiscovery({
      authFetch, crawlerType: 'scim', configId,
      buildConfig: () => ({ baseUrl: 'https://x' }),
      emptyResult: EMPTY, errorHint: 'could not reach it',
    }), { wrapper });

  it('posts the typed config to the crawler-specific discover route', async () => {
    const authFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ things: [1] }) }));
    const { result } = setup(authFetch);
    await act(() => result.current.fetchDiscovery());
    const [url, opts] = authFetch.mock.calls[0];
    expect(url).toBe('/api/admin/crawlers/scim/discover');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(opts.body)).toEqual({ config: { baseUrl: 'https://x' } });
    expect(result.current.disco).toEqual({ things: [1] });
  });

  it('sends the saved configId instead, so the server reads the vaulted secret', async () => {
    const authFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const { result } = setup(authFetch, 42);
    await act(() => result.current.fetchDiscovery());
    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({ configId: 42 });
  });

  it('degrades to the empty result and a hint rather than blocking the wizard', async () => {
    const authFetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad creds' }) }));
    const { result } = setup(authFetch);
    await act(() => result.current.fetchDiscovery());
    expect(result.current.disco).toEqual(EMPTY);
    expect(result.current.discoError).toBe('bad creds');
  });

  it('uses the hint when the failure carries no message, and when the call throws', async () => {
    const noMessage = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const { result: r1 } = setup(noMessage);
    await act(() => r1.current.fetchDiscovery());
    expect(r1.current.discoError).toBe('could not reach it');

    const throws = vi.fn(async () => { throw new Error('network'); });
    const { result: r2 } = setup(throws);
    await act(() => r2.current.fetchDiscovery());
    expect(r2.current.disco).toEqual(EMPTY);
    expect(r2.current.discoError).toBe('could not reach it');
  });

  it('reports itself loading while the request is open, and clears a previous error', async () => {
    // The wizard disables "Re-run discovery" on this flag, and the guard below
    // relies on it too — a stuck-false flag would let clicks stack up.
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let response = { ok: false, status: 500, json: async () => ({ error: "first failure" }) };
    const authFetch = vi.fn(() => response);
    const { result } = setup(authFetch);

    await act(() => result.current.fetchDiscovery());
    expect(result.current.discoError).toBe('first failure');

    response = pending;
    let done;
    act(() => { done = result.current.fetchDiscovery({ force: true }); });
    await waitFor(() => expect(result.current.discoLoading).toBe(true));
    expect(result.current.discoError).toBeNull();

    await act(async () => { release({ ok: true, status: 200, json: async () => ({ things: [] }) }); await done; });
    expect(result.current.discoLoading).toBe(false);
  });

  it('falls back to the hint when the error body is not JSON at all', async () => {
    const authFetch = vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); },
    }));
    const { result } = setup(authFetch);
    await act(() => result.current.fetchDiscovery());
    expect(result.current.discoError).toBe('could not reach it');
    expect(result.current.disco).toEqual(EMPTY);
  });

  it('does not re-run once it has a result — arriving back on the step is free', async () => {
    const authFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ things: [] }) }));
    const { result } = setup(authFetch);
    await act(() => result.current.fetchDiscovery());
    await act(() => result.current.fetchDiscovery());
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it('re-runs when forced — that is the "Re-run discovery" button', async () => {
    const authFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ things: [] }) }));
    const { result } = setup(authFetch);
    await act(() => result.current.fetchDiscovery());
    await act(() => result.current.fetchDiscovery({ force: true }));
    expect(authFetch).toHaveBeenCalledTimes(2);
  });
});
