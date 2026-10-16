// Analyst decisions on one org link, shared by Review and the entity detail page:
//   override(link, 'confirmed' | 'rejected')     PUT  /api/org-truth/links/:id/override { action }
//   override(link, 'moved', targetId)            PUT  … { action: 'moved', targetId }
//   override(link, 'clear')                      DELETE /api/org-truth/links/:id/override
// On success a toast and `onDone()` (the caller refetches); on failure the
// sentence lands in `error` for the caller to show inline next to the rows.
import { useState, useCallback } from 'react';
import { useDialog } from '@ui/components/dialogContext';

const DONE_TEXT = { confirmed: 'Link confirmed', rejected: 'Link rejected', moved: 'Link moved', clear: 'Decision undone' };

async function errorSentence(res) {
  if (res.status === 501) return 'Reviewing links is not available yet.';
  let detail = '';
  try {
    detail = (await res.json())?.error || '';
  } catch { /* body is optional */ }
  return detail ? `The decision was not saved: ${detail}` : `The decision was not saved (HTTP ${res.status}).`;
}

export function useLinkOverride({ authFetch, onDone }) {
  const dialog = useDialog();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const override = useCallback(async (linkId, action, targetId) => {
    setBusy(linkId);
    setError(null);
    const url = `/api/org-truth/links/${encodeURIComponent(linkId)}/override`;
    const opts = action === 'clear'
      ? { method: 'DELETE' }
      : {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(targetId ? { action, targetId } : { action }),
      };
    try {
      const res = await authFetch(url, opts);
      if (!res.ok) {
        setError(await errorSentence(res));
        return false;
      }
      dialog.toast(DONE_TEXT[action] || 'Saved', { variant: 'success' });
      onDone?.();
      return true;
    } catch (err) {
      setError(`The decision was not saved: ${err.message}`);
      return false;
    } finally {
      setBusy(null);
    }
  }, [authFetch, dialog, onDone]);

  return { busy, error, override };
}
