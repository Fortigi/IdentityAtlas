// Rename and Duplicate for a saved matrix — the name menu's two naming verbs
// (#1202).
//
// Both ask for one name and can hit the same wall: saved-matrix names are unique
// across the org, and a clash comes back as a 409 that must be shown under the
// field (the dialog stays open) rather than as a toast after it closed.

import { useCallback, useState } from 'react';
import { copyName, renameShareWarning } from './shareState';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// The request each verb sends. Rename changes only the name; Duplicate stores
// the saved matrix's filter as it was saved (governed toggle included) under
// the new name.
export function namingRequest(mode, row, name) {
  if (mode === 'rename') {
    return {
      url: `/api/matrix/saved-filters/${row.id}`,
      init: { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name }) },
    };
  }
  return {
    url: '/api/matrix/saved-filters',
    init: { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name, filter: row.filter || {} }) },
  };
}

// The dialog's wording per verb.
export function namingCopy(mode, row) {
  if (mode === 'rename') {
    return { title: 'Rename matrix', saveLabel: 'Rename', notice: renameShareWarning(row), success: 'Matrix renamed' };
  }
  return { title: 'Duplicate matrix', saveLabel: 'Duplicate', notice: '', success: 'Matrix duplicated' };
}

export function useSavedMatrixNaming({ authFetch, dialog, onDone }) {
  // { mode: 'rename' | 'duplicate', row, name, error, saving } — null when closed.
  const [state, setState] = useState(null);

  const openRename = useCallback(row => {
    setState({ mode: 'rename', row, name: row.name, error: null, saving: false });
  }, []);
  const openDuplicate = useCallback(row => {
    setState({ mode: 'duplicate', row, name: copyName(row.name), error: null, saving: false });
  }, []);
  const setName = useCallback(name => setState(s => ({ ...s, name })), []);
  const close = useCallback(() => setState(null), []);

  const submit = useCallback(async () => {
    if (!state) return;
    const { mode, row } = state;
    const { url, init } = namingRequest(mode, row, state.name.trim());
    setState(s => ({ ...s, saving: true, error: null }));
    try {
      const res = await authFetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not save this name (HTTP ${res.status})`);
      setState(null);
      dialog.toast(namingCopy(mode, row).success, { variant: 'success' });
      onDone?.(mode, body);
    } catch (err) {
      setState(s => ({ ...s, saving: false, error: err.message }));
    }
  }, [authFetch, dialog, onDone, state]);

  return { state, openRename, openDuplicate, setName, close, submit };
}
