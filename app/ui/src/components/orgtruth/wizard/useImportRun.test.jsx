// @vitest-environment jsdom
//
// useImportRun: POST /runs, then GET /runs/:id every 1.5 s until the run is
// completed or failed; a failing poll keeps polling; a failing start reports.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { makeWrapper, makeAuthFetch, jsonResponse, renderHook, act } from '@ui/test-utils/renderWithProviders';
import { useImportRun, isFinished, POLL_MS } from './useImportRun';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function sequence(...answers) {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
}

const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });

describe('isFinished', () => {
  it('is true only for completed and failed', () => {
    expect(isFinished({ status: 'completed' })).toBe(true);
    expect(isFinished({ status: 'failed' })).toBe(true);
    expect(isFinished({ status: 'running' })).toBe(false);
    expect(isFinished(null)).toBe(false);
  });
});

describe('useImportRun', () => {
  it('starts the run and polls it until it completes, then stops', async () => {
    const next = sequence(
      { id: 'r1', status: 'running', step: 'parse', pct: 10 },
      jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
      { id: 'r1', status: 'completed', stats: { rows: 3 } },
    );
    const authFetch = makeAuthFetch((url, opts) => {
      if (url === '/api/org-truth/runs' && opts.method === 'POST') return jsonResponse({ id: 'r1', status: 'queued' }, { status: 202 });
      if (url === '/api/org-truth/runs/r1') return next();
      return undefined;
    });
    const { result } = renderHook(() => useImportRun(), makeWrapper({ auth: { authFetch } }));

    let created;
    await act(async () => { created = await result.current.start({ sourceId: 's1', profileId: 7, mode: 'full' }); });
    expect(created).toEqual({ id: 'r1', status: 'queued' });
    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({ sourceId: 's1', profileId: 7, mode: 'full' });
    expect(result.current.busy).toBe(true);
    expect(result.current.run.status).toBe('queued');

    await tick();
    expect(result.current.run).toMatchObject({ status: 'running', step: 'parse', pct: 10 });
    await tick(); // the failing poll keeps the last state and keeps polling
    expect(result.current.run.status).toBe('running');
    await tick();
    expect(result.current.run).toMatchObject({ status: 'completed', stats: { rows: 3 } });
    expect(result.current.busy).toBe(false);

    const calls = authFetch.mock.calls.length;
    await tick();
    expect(authFetch.mock.calls.length).toBe(calls);
    expect(result.current.error).toBeNull();
  });

  it('does not poll a run that is already finished when created', async () => {
    const authFetch = makeAuthFetch({ '/api/org-truth/runs': jsonResponse({ id: 'r2', status: 'failed', error: 'x' }, { status: 202 }) });
    const { result } = renderHook(() => useImportRun(), makeWrapper({ auth: { authFetch } }));
    await act(async () => { await result.current.start({}); });
    expect(result.current.busy).toBe(false);
    await tick();
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it('reports a failed start and does not poll', async () => {
    const authFetch = makeAuthFetch({ '/api/org-truth/runs': jsonResponse({ error: 'A run for this profile is already running' }, { ok: false, status: 409 }) });
    const { result } = renderHook(() => useImportRun(), makeWrapper({ auth: { authFetch } }));
    let created;
    await act(async () => { created = await result.current.start({}); });
    expect(created).toBeNull();
    expect(result.current.error).toBe('A run for this profile is already running');
    expect(result.current.busy).toBe(false);
    expect(result.current.run).toBeNull();
  });

  it('tracks a run another call created and calls onFinish once when it ends', async () => {
    const next = sequence({ id: 'r9', status: 'running', pct: 50 }, { id: 'r9', status: 'completed' });
    const authFetch = makeAuthFetch((url) => (url === '/api/org-truth/runs/r9' ? next() : undefined));
    const onFinish = vi.fn();
    const { result } = renderHook(() => useImportRun(), makeWrapper({ auth: { authFetch } }));
    act(() => result.current.track({ id: 'r9', status: 'queued' }, onFinish));
    expect(result.current.busy).toBe(true);
    expect(result.current.run.status).toBe('queued');
    await tick();
    expect(result.current.run.pct).toBe(50);
    expect(onFinish).not.toHaveBeenCalled();
    await tick();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith({ id: 'r9', status: 'completed' });
    expect(result.current.busy).toBe(false);
    await tick();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it('calls onFinish straight away for a run that is already finished', () => {
    const authFetch = makeAuthFetch({});
    const onFinish = vi.fn();
    const { result } = renderHook(() => useImportRun(), makeWrapper({ auth: { authFetch } }));
    act(() => result.current.track({ id: 'r8', status: 'failed' }, onFinish));
    expect(onFinish).toHaveBeenCalledWith({ id: 'r8', status: 'failed' });
    expect(result.current.busy).toBe(false);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('stops polling on unmount', async () => {
    const authFetch = makeAuthFetch((url, opts) => (opts.method === 'POST'
      ? jsonResponse({ id: 'r3', status: 'queued' }, { status: 202 })
      : { id: 'r3', status: 'running' }));
    const { result, unmount } = renderHook(() => useImportRun(), makeWrapper({ auth: { authFetch } }));
    await act(async () => { await result.current.start({}); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
