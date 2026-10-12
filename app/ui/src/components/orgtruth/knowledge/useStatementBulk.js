// Bulk review of one transcript's statements, and "Score again".
//
//   const { busy, bulk, rescore } = useStatementBulk(sourceId, reload);
//   await bulk('accepted', claims, 'High confidence');   // confirm, then PUT …/claims/bulk
//   await rescore();                                      // POST …/rescore, toast, reload
//
// bulk() sends only the ids of the PROPOSED statements in `claims` (the server
// changes nothing else either) and nothing at all when there are none or the
// reviewer cancels. The server is the source of truth: both reload afterwards.
import { useCallback, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { sendJson } from '@ui/components/orgtruth/wizard/wizardApi';
import { KNOWLEDGE, bulkMessage, proposedIds, rescoreText } from './knowledgeFormat';
import { useKnowledgeDecision } from './useKnowledgeDecision';

export function useStatementBulk(sourceId, reload) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const { busy, decide } = useKnowledgeDecision(reload);
  const [scoring, setScoring] = useState(false);
  const base = `${KNOWLEDGE}/sources/${encodeURIComponent(sourceId)}`;

  const bulk = useCallback(async (status, claims, scope) => {
    const ids = proposedIds(claims);
    if (ids.length === 0) return false;
    const ok = await dialog.confirm({
      title: status === 'accepted' ? 'Accept statements' : 'Reject statements',
      message: bulkMessage(status, ids.length, scope),
      confirmLabel: status === 'accepted' ? `Accept ${ids.length}` : `Reject ${ids.length}`,
      danger: status === 'rejected',
    });
    if (!ok) return false;
    return decide(`${base}/claims/bulk`, { status, ids });
  }, [base, decide, dialog]);

  const rescore = useCallback(async () => {
    setScoring(true);
    try {
      const result = await sendJson(authFetch, `${base}/rescore`, {}, 'POST');
      dialog.toast(rescoreText(result), { variant: 'success' });
    } catch (err) {
      dialog.alert(`Not scored: ${err.message}`);
    } finally {
      setScoring(false);
      reload();
    }
  }, [authFetch, base, dialog, reload]);

  return { busy: busy ?? (scoring ? `${base}/rescore` : null), bulk, rescore };
}
