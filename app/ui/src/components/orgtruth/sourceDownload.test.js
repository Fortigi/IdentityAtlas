// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blobResponse, jsonResponse, makeAuthFetch, makeWrapper, renderHook, screen, waitFor, act } from '@ui/test-utils/renderWithProviders';

vi.mock('@ui/utils/download', async (orig) => ({ ...(await orig()), triggerDownload: vi.fn() }));
const { triggerDownload } = await import('@ui/utils/download');
const { downloadSource, useSourceDownload } = await import('./sourceDownload');

beforeEach(() => triggerDownload.mockClear());

describe('downloadSource', () => {
  it('saves the bytes under the name the server gives', async () => {
    const authFetch = makeAuthFetch({ '/download': blobResponse('a;b', { filename: 'projects-2026.csv' }) });
    const name = await downloadSource(authFetch, { id: 's 1', fileName: 'local.csv' });
    expect(authFetch).toHaveBeenCalledWith('/api/org-truth/sources/s%201/download');
    expect(name).toBe('projects-2026.csv');
    expect(triggerDownload).toHaveBeenCalledWith('projects-2026.csv', expect.any(Blob));
  });

  it('falls back to the file name, then the display name, then "source"', async () => {
    const authFetch = makeAuthFetch({ '/download': blobResponse('x') });
    expect(await downloadSource(authFetch, { id: 's', fileName: 'f.xlsx', displayName: 'D' })).toBe('f.xlsx');
    expect(await downloadSource(authFetch, { id: 's', displayName: 'D' })).toBe('D');
    expect(await downloadSource(authFetch, { id: 's' })).toBe('source');
  });

  it('throws a sentence on 501 and on any other failure', async () => {
    await expect(downloadSource(makeAuthFetch({ '/download': jsonResponse({}, { ok: false, status: 501 }) }), { id: 's' }))
      .rejects.toThrow('Download is not available yet.');
    await expect(downloadSource(makeAuthFetch({}), { id: 's' })).rejects.toThrow('Download failed (HTTP 404).');
    expect(triggerDownload).not.toHaveBeenCalled();
  });
});

describe('useSourceDownload', () => {
  it('shows a failed download as an error toast', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useSourceDownload(makeAuthFetch({})), { wrapper });
    await act(() => result.current({ id: 's' }));
    await waitFor(() => expect(screen.getByText('Download failed (HTTP 404).')).toBeInTheDocument());
  });
});
