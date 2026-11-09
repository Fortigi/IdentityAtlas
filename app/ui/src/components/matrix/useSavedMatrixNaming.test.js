// @vitest-environment jsdom
// Unit tests for the Rename / Duplicate requests, their wording, and the hook's
// lifecycle (#1202). MatrixNameBar.mount.test.jsx drives the same lifecycle
// through the strip, but it is not in the mutation run's include list (mounting
// the strip per mutant is the expensive kind of test). So the hook is also
// covered here, where a mutant in it can actually be killed.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import { namingRequest, namingCopy, useSavedMatrixNaming } from './useSavedMatrixNaming';

const ROW = { id: 'sf-1', name: 'HR users', filter: { rowType: 'principal', managed: 'gaps' }, shared: true, recipientCount: 2 };

describe('namingRequest', () => {
  it('renames with a PUT that carries ONLY the new name', () => {
    const { url, init } = namingRequest('rename', ROW, 'People team');
    expect(url).toBe('/api/matrix/saved-filters/sf-1');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ name: 'People team' });
  });

  it('duplicates with a POST of the stored filter, governed toggle included', () => {
    const { url, init } = namingRequest('duplicate', ROW, 'Copy of HR users');
    expect(url).toBe('/api/matrix/saved-filters');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ name: 'Copy of HR users', filter: { rowType: 'principal', managed: 'gaps' } });
  });

  it('duplicates a row with no stored filter as an empty one rather than dropping the field', () => {
    expect(JSON.parse(namingRequest('duplicate', { id: 'x', name: 'X' }, 'Y').init.body)).toEqual({ name: 'Y', filter: {} });
  });
});

describe('namingCopy', () => {
  it('words a rename, warning recipients of a shared matrix', () => {
    expect(namingCopy('rename', ROW)).toEqual({
      title: 'Rename matrix', saveLabel: 'Rename',
      notice: 'Shared with 2 people — they will see the new name.', success: 'Matrix renamed',
    });
    expect(namingCopy('rename', { ...ROW, shared: false }).notice).toBe('');
  });

  it('words a duplicate, with no share warning — the copy is not shared', () => {
    expect(namingCopy('duplicate', ROW)).toEqual({ title: 'Duplicate matrix', saveLabel: 'Duplicate', notice: '', success: 'Matrix duplicated' });
  });
});

// A response the hook can read; `json` may reject, as it does for an empty body.
function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)) };
}

function setup({ authFetch = vi.fn(), onDone = vi.fn() } = {}) {
  const dialog = { toast: vi.fn() };
  const hook = renderHook(() => useSavedMatrixNaming({ authFetch, dialog, onDone }));
  return { hook, authFetch, dialog, onDone };
}

describe('useSavedMatrixNaming', () => {
  it('starts closed', () => {
    expect(setup().hook.result.current.state).toBeNull();
  });

  it('opens Rename on the current name and Duplicate on a "Copy of" name', () => {
    const { hook } = setup();
    act(() => hook.result.current.openRename(ROW));
    expect(hook.result.current.state).toEqual({ mode: 'rename', row: ROW, name: 'HR users', error: null, saving: false });
    act(() => hook.result.current.openDuplicate(ROW));
    expect(hook.result.current.state).toEqual({ mode: 'duplicate', row: ROW, name: 'Copy of HR users', error: null, saving: false });
  });

  it('edits the name without losing the rest of the dialog, and closes', () => {
    const { hook } = setup();
    act(() => hook.result.current.openRename(ROW));
    act(() => hook.result.current.setName('People team'));
    expect(hook.result.current.state).toEqual({ mode: 'rename', row: ROW, name: 'People team', error: null, saving: false });
    act(() => hook.result.current.close());
    expect(hook.result.current.state).toBeNull();
  });

  it('does nothing when submitted while closed', async () => {
    const { hook, authFetch } = setup();
    await act(() => hook.result.current.submit());
    expect(authFetch).not.toHaveBeenCalled();
    expect(hook.result.current.state).toBeNull();
  });

  it('sends the TRIMMED name, closes, toasts the verb and reports the saved row', async () => {
    const saved = { id: 'sf-1', name: 'People team' };
    const { hook, authFetch, dialog, onDone } = setup({ authFetch: vi.fn().mockResolvedValue(response(200, saved)) });
    act(() => hook.result.current.openRename(ROW));
    act(() => hook.result.current.setName('  People team  '));
    await act(() => hook.result.current.submit());
    expect(authFetch).toHaveBeenCalledTimes(1);
    const [url, init] = authFetch.mock.calls[0];
    expect(url).toBe('/api/matrix/saved-filters/sf-1');
    expect(JSON.parse(init.body)).toEqual({ name: 'People team' });
    expect(hook.result.current.state).toBeNull();
    expect(dialog.toast).toHaveBeenCalledWith('Matrix renamed', { variant: 'success' });
    expect(onDone).toHaveBeenCalledWith('rename', saved);
  });

  it('closes on success with no onDone handler rather than reporting an error', async () => {
    const authFetch = vi.fn().mockResolvedValue(response(201, { id: 'sf-2' }));
    const dialog = { toast: vi.fn() };
    const hook = renderHook(() => useSavedMatrixNaming({ authFetch, dialog }));
    act(() => hook.result.current.openDuplicate(ROW));
    await act(() => hook.result.current.submit());
    expect(hook.result.current.state).toBeNull();
    expect(dialog.toast).toHaveBeenCalledWith('Matrix duplicated', { variant: 'success' });
  });

  it("keeps the dialog open with the API's own message on a refusal (the inline 409)", async () => {
    const { hook, dialog, onDone } = setup({ authFetch: vi.fn().mockResolvedValue(response(409, { error: 'A matrix with that name already exists' })) });
    act(() => hook.result.current.openRename(ROW));
    act(() => hook.result.current.setName('Taken'));
    await act(() => hook.result.current.submit());
    expect(hook.result.current.state).toEqual({ mode: 'rename', row: ROW, name: 'Taken', error: 'A matrix with that name already exists', saving: false });
    expect(dialog.toast).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('falls back to a message with the HTTP status when the refusal has no readable body', async () => {
    const { hook } = setup({ authFetch: vi.fn().mockResolvedValue(response(500, new SyntaxError('Unexpected end of JSON'))) });
    act(() => hook.result.current.openRename(ROW));
    await act(() => hook.result.current.submit());
    expect(hook.result.current.state.error).toBe('Could not save this name (HTTP 500)');
  });

  it('marks the dialog saving and clears the previous error while the request is in flight', async () => {
    let finish;
    const authFetch = vi.fn()
      .mockResolvedValueOnce(response(409, { error: 'Taken' }))
      .mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const { hook } = setup({ authFetch });
    act(() => hook.result.current.openRename(ROW));
    await act(() => hook.result.current.submit());
    expect(hook.result.current.state.error).toBe('Taken');
    let pending;
    act(() => { pending = hook.result.current.submit(); });
    expect(hook.result.current.state).toMatchObject({ saving: true, error: null });
    await act(async () => { finish(response(200, {})); await pending; });
    expect(hook.result.current.state).toBeNull();
  });
});
