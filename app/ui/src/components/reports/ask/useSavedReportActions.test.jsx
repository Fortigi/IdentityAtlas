// @vitest-environment jsdom
//
// Save and delete for the report builder — the paths the page mount test does not
// reach: deleting (confirmed, declined, refused by the server) and a failed save.
// The builder id carries a space and a slash, so an unencoded URL cannot pass.
import { describe, it, expect, vi } from 'vitest';
import { makeAuthFetch, jsonResponse, renderHook, act } from '@ui/test-utils/renderWithProviders';
import { useSavedReportActions } from './useSavedReportActions';

const ID = 'team a/b';
const URL = '/api/nl-reports/saved/team%20a%2Fb';
const DRAFT = { name: 'Stale guests', description: 'd', question: 'q', spec: { entity: 'user' } };

function setup({ answer, confirmed = true, isNew = false } = {}) {
  const authFetch = makeAuthFetch(() => answer);
  const dialog = { confirm: vi.fn(async () => confirmed) };
  const cb = { onOpenDetail: vi.fn(), onClose: vi.fn(), onCacheData: vi.fn() };
  const hook = renderHook(() => useSavedReportActions({ authFetch, dialog, builderId: ID, isNew, draft: DRAFT, ...cb }));
  return { hook, authFetch, dialog, ...cb };
}

const refused = jsonResponse({ error: 'Report is locked' }, { ok: false, status: 409 });

describe('useSavedReportActions', () => {
  it('deletes the report under its encoded id once the analyst confirms, then closes the tab', async () => {
    const { hook, authFetch, dialog, onClose } = setup({ answer: { ok: true } });

    await act(() => hook.result.current.remove());

    expect(dialog.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Delete the report "Stale guests"? This cannot be undone.', danger: true,
    }));
    expect(authFetch.mock.calls.map(([u, o]) => [u, o.method])).toEqual([[URL, 'DELETE']]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the analyst declines the delete', async () => {
    const { hook, authFetch, onClose } = setup({ confirmed: false, answer: { ok: true } });

    await act(() => hook.result.current.remove());

    expect(authFetch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(hook.result.current.message).toBeNull();
  });

  it('keeps the tab open and shows the server reason when a delete is refused', async () => {
    const { hook, onClose } = setup({ answer: refused });

    await act(() => hook.result.current.remove());

    expect(onClose).not.toHaveBeenCalled();
    expect(hook.result.current.message).toEqual({ kind: 'err', text: 'Report is locked' });
  });

  it('reports a failed update without relabelling the tab, and is ready to save again', async () => {
    const { hook, authFetch, onCacheData } = setup({ answer: refused });

    await act(() => hook.result.current.save());

    expect(authFetch.mock.calls.map(([u, o]) => [u, o.method])).toEqual([[URL, 'PUT']]);
    expect(onCacheData).not.toHaveBeenCalled();
    expect(hook.result.current.message).toEqual({ kind: 'err', text: 'Report is locked' });
    expect(hook.result.current.saving).toBe(false);
  });

  it('does not swap tabs when creating a new report fails', async () => {
    const { hook, onOpenDetail, onClose } = setup({ isNew: true, answer: refused });

    await act(() => hook.result.current.save());

    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(hook.result.current.message).toEqual({ kind: 'err', text: 'Report is locked' });
  });
});
