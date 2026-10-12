// One reviewer decision: PUT the body, then refetch — the server is the source
// of truth, also when the PUT is refused (a 409 means someone else decided
// first: show their message, then show what they decided).
//
//   const { busy, decide } = useKnowledgeDecision(reload);
//   await decide(`/knowledge/claims/${id}`, { status: 'accepted', expectedStatus: 'proposed' });
import { useCallback, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { sendJson } from '@ui/components/orgtruth/wizard/wizardApi';

export function useKnowledgeDecision(reload) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [busy, setBusy] = useState(null);

  const decide = useCallback(async (path, body) => {
    setBusy(path);
    try {
      await sendJson(authFetch, path, body, 'PUT');
      return true;
    } catch (err) {
      dialog.alert(`Not saved: ${err.message}`);
      return false;
    } finally {
      setBusy(null);
      reload();
    }
  }, [authFetch, dialog, reload]);

  return { busy, decide };
}
