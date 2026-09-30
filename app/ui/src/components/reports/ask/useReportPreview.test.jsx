// @vitest-environment jsdom
//
// The builder's working definition and preview run — the paths the page mount test
// does not reach: a hand edit marking the preview stale, a resolve that asks again,
// and a resolve that fails.
import { describe, it, expect } from 'vitest';
import { makeAuthFetch, jsonResponse, renderHook, act } from '@ui/test-utils/renderWithProviders';
import { useReportPreview } from './useReportPreview';

const SENT = { entity: 'user', conditions: [] };
const NORMALISED = { entity: 'user', conditions: [], limit: 500 };
const ASK = (name) => ({ kind: 'reference', path: [0], name, message: `Did you mean ${name}?`, choices: [] });

function setup(handler) {
  const authFetch = makeAuthFetch(handler);
  return { hook: renderHook(() => useReportPreview(authFetch)), authFetch };
}

describe('useReportPreview', () => {
  it('marks a hand edit as out of date, and a run adopts the definition the server ran', async () => {
    const { hook } = setup({ '/run': { spec: NORMALISED, total: 0 } });

    act(() => hook.result.current.editSpec(SENT));
    expect(hook.result.current).toMatchObject({ spec: SENT, dirty: true, result: null });

    await act(() => hook.result.current.run(SENT));
    expect(hook.result.current).toMatchObject({ spec: NORMALISED, dirty: false, running: false, runError: null });
    expect(hook.result.current.result.total).toBe(0);
  });

  it('asks again when the resolved definition still names something ambiguous, without running it', async () => {
    const half = { entity: 'user', conditions: [{ value: 'half' }] };
    const { hook, authFetch } = setup({
      '/run': jsonResponse({ error: 'Invalid', confirm: ASK('first'), spec: SENT }, { ok: false, status: 400 }),
      '/resolve': { spec: half, confirm: ASK('second') },
    });

    await act(() => hook.result.current.run(SENT));
    expect(hook.result.current.confirm).toEqual({ spec: SENT, confirm: ASK('first') });

    await act(() => hook.result.current.confirmChoice({ path: [0], name: 'x' }));

    expect(hook.result.current.confirm).toEqual({ spec: half, confirm: ASK('second') });
    expect(hook.result.current.spec).toEqual(half);
    expect(authFetch.mock.calls.filter(([u]) => u.endsWith('/run'))).toHaveLength(1);
  });

  it('shows why a resolve failed and stops running', async () => {
    const { hook } = setup({
      '/run': jsonResponse({ error: 'Invalid', confirm: ASK('first'), spec: SENT }, { ok: false, status: 400 }),
      '/resolve': jsonResponse({ error: 'Lookup unavailable' }, { ok: false, status: 503 }),
    });

    await act(() => hook.result.current.run(SENT));
    await act(() => hook.result.current.confirmChoice({ path: [0], name: 'x' }));

    expect(hook.result.current).toMatchObject({ runError: 'Lookup unavailable', running: false });
  });
});

describe('the conversation-store row', () => {
  it('sends the log id to /run when given one, and nothing about it otherwise', async () => {
    const seen = [];
    const { hook } = setup((url, opts) => {
      seen.push(JSON.parse(opts.body));
      return jsonResponse({ spec: NORMALISED, total: 0 });
    });
    await act(() => hook.result.current.run(SENT, '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab'));
    await act(() => hook.result.current.run(SENT));

    expect(seen[0].logId).toBe('3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab');
    expect(seen[1]).not.toHaveProperty('logId');
  });
});

describe('starting over', () => {
  it('clears the definition, the result and a pending choice together', async () => {
    // The Ask tab calls this when a conversation starts over or another one is
    // opened. A result left on screen from the previous chat would read as
    // this one's answer.
    const { hook } = setup({ '/run': { spec: NORMALISED, total: 3 } });
    await act(() => hook.result.current.run(SENT));
    expect(hook.result.current.result.total).toBe(3);

    act(() => hook.result.current.reset());
    expect(hook.result.current).toMatchObject({ spec: null, dirty: false, result: null, runError: null, confirm: null });
  });
});
