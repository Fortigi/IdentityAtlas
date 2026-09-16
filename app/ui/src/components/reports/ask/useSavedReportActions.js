// PROTOTYPE — save and delete for the report builder.
//
// Saving a new report swaps the "new" tab for the saved report's own tab; saving an
// existing one stays put and relabels the tab.

import { useState } from 'react';
import { postJson } from './AskAssistant.api';

/**
 * @param {object} opts.draft  { name, description, question, spec } — what gets saved
 */
export function useSavedReportActions({ authFetch, dialog, builderId, isNew, draft, onOpenDetail, onClose, onCacheData }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const savedUrl = `/api/nl-reports/saved/${encodeURIComponent(builderId)}`;

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const body = { name: draft.name, description: draft.description, question: draft.question, definition: draft.spec };
      if (isNew) {
        const row = await postJson(authFetch, '/api/nl-reports/saved', body);
        // Swap this "new" tab for the saved report's own tab, so the URL can be
        // reopened. Open first: closing the active tab would navigate away.
        onOpenDetail?.('report-builder', row.id, row.name);
        onClose?.();
        return;
      }
      await postJson(authFetch, savedUrl, body, 'PUT');
      onCacheData?.(builderId, 'report-builder', { displayName: draft.name });
      setMessage({ kind: 'ok', text: 'Saved' });
    } catch (e) {
      setMessage({ kind: 'err', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await dialog.confirm({ message: `Delete the report "${draft.name}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await postJson(authFetch, savedUrl, null, 'DELETE');
      onClose?.();
    } catch (e) {
      setMessage({ kind: 'err', text: e.message });
    }
  };

  return { save, remove, saving, message };
}
