// Delete an organisation source (DELETE /api/org-truth/sources/:id): its runs,
// entities, relations and links go with it, and the projection trees are
// rebuilt by the server. The user confirms first; a 409 (an import is still
// running) and other failures are shown, never swallowed.
import { useCallback } from 'react';
import { useDialog } from '@ui/components/dialogContext';

export function deleteMessage(source) {
  return `Delete "${source.displayName}"? Everything read from it — its entities, relations, links to accounts and groups, and its import runs — is removed, and the organisation contexts are rebuilt without it. The original file is gone too.`;
}

export async function deleteSourceRequest(authFetch, source) {
  const res = await authFetch(`/api/org-truth/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' });
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) throw new Error(body.error || 'An import of this source is still running; wait for it to finish.');
  if (res.status === 501) throw new Error('Deleting a source is not available yet.');
  throw new Error(body.error || `Delete failed (HTTP ${res.status}).`);
}

// The click handler a panel wires to its Delete button. Resolves true when the
// source was deleted (the caller reloads), false when cancelled or failed.
export function useSourceDelete(authFetch) {
  const dialog = useDialog();
  return useCallback(async (source) => {
    const ok = await dialog.confirm({ message: deleteMessage(source), confirmLabel: 'Delete', danger: true });
    if (!ok) return false;
    try {
      await deleteSourceRequest(authFetch, source);
      dialog.toast(`"${source.displayName}" deleted`, { variant: 'success' });
      return true;
    } catch (err) {
      dialog.alert(err.message);
      return false;
    }
  }, [authFetch, dialog]);
}
