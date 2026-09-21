// Saving the draft: the first save creates the context tree; later saves refresh the
// same tree in place (the server keeps renames and re-parenting). The tree is built
// while the request waits, so the answer carries the context to open.

import { useState } from 'react';
import { postJson } from '@ui/components/reports/ask/AskAssistant.api';

/** The sentence shown after a save. */
export function savedMessage(result, created) {
  if (created) return `Created — ${result.membersAdded ?? 0} objects added.`;
  const added = result.membersAdded ?? 0;
  const removed = result.membersRemoved ?? 0;
  return added || removed ? `Saved — ${added} added, ${removed} removed.` : 'Saved — no change in membership.';
}

/**
 * @param {object} args
 * @param {Function} args.authFetch
 * @param {string|null} args.initialContextId  the tree being edited, or null for a new one
 * @param {Function} [args.onSaved]             (contextId, name) after a successful save
 */
export function useContextSave({ authFetch, initialContextId, onSaved }) {
  const [contextId, setContextId] = useState(initialContextId);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const save = async (recipe, question) => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await postJson(authFetch, '/api/context-assistant/save', { recipe, question, contextId: contextId || undefined });
      const created = !contextId;
      if (result.contextId) setContextId(result.contextId);
      setMessage({ kind: 'ok', text: savedMessage(result, created) });
      onSaved?.(result.contextId, recipe.name);
    } catch (err) {
      const detail = err.body?.detail ? ` (${err.body.detail})` : '';
      setMessage({ kind: 'error', text: `${err.message}${detail}` });
    } finally {
      setSaving(false);
    }
  };

  return { contextId, saving, message, save };
}
