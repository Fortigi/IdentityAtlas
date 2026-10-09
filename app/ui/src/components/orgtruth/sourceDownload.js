// Download the original bytes of an organisation source
// (GET /api/org-truth/sources/:id/download). The server names the file through
// Content-Disposition; the source's own fileName / displayName is the fallback.
import { useCallback } from 'react';
import { triggerDownload, filenameFromDisposition } from '@ui/utils/download';
import { useDialog } from '@ui/components/dialogContext';

export async function downloadSource(authFetch, source) {
  const res = await authFetch(`/api/org-truth/sources/${encodeURIComponent(source.id)}/download`);
  if (!res.ok) throw new Error(res.status === 501 ? 'Download is not available yet.' : `Download failed (HTTP ${res.status}).`);
  const blob = await res.blob();
  const filename = filenameFromDisposition(res.headers?.get?.('Content-Disposition'))
    || source.fileName || source.displayName || 'source';
  triggerDownload(filename, blob);
  return filename;
}

// The click handler a panel wires to its Download button: downloads, and shows
// a failure as an error toast.
export function useSourceDownload(authFetch) {
  const dialog = useDialog();
  return useCallback(async (source) => {
    try {
      await downloadSource(authFetch, source);
    } catch (err) {
      dialog.alert(err.message);
    }
  }, [authFetch, dialog]);
}
