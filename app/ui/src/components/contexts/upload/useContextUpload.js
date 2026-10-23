import { useCallback, useState } from 'react';
import { useFetch } from '@ui/hooks/useFetch';

// The state and the API calls of the "Upload a list" wizard:
//   analyze()  POST /api/contexts/uploads/analyze  (the file → columns + best guess)
//   preview()  POST /api/contexts/uploads/preview  (the mapping → what would happen)
//   apply()    POST /api/contexts/uploads/apply    (write it; resolves to the result)
// plus the uploaded lists for the "update an existing list" picker.
// Each call sets `busy` while it runs and `error` (a sentence) when it fails.

// The JSON body of a response, or an Error carrying the API's sentence (and its
// details). Shared with the activity upload (contexts/activity/useActivityUpload.js).
export async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(body.details) && body.details.length ? `: ${body.details.join(' ')}` : '';
    throw new Error(`${body.error || `HTTP ${res.status}`}${detail}`);
  }
  return body;
}

export function useContextUpload(authFetch, { initialListId = null } = {}) {
  const lists = useFetch('/api/contexts/uploads', { authFetch, transform: (b) => b.data || [], initialData: [] });
  const [file, setFile] = useState(null);
  const [listId, setListId] = useState(initialListId ? String(initialListId) : '');
  const [analysis, setAnalysis] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [preview, setPreview] = useState(null);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (err) { setError(err.message || 'Something went wrong'); return null; } finally { setBusy(false); }
  }, []);

  const post = useCallback(async (path, body) => readJson(await authFetch(`/api/contexts/uploads/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })), [authFetch]);

  const analyze = () => run(async () => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    if (listId) fd.append('listId', listId);
    const result = await readJson(await authFetch('/api/contexts/uploads/analyze', { method: 'POST', body: fd }));
    setAnalysis(result); setMapping(result.guess); setPreview(null);
    return result;
  });

  const listBody = () => ({ uploadDraftId: analysis.uploadDraftId, mapping, ...(listId ? { listId: Number(listId) } : {}) });
  const runPreview = () => run(async () => {
    const result = await post('preview', listBody());
    setPreview(result);
    return result;
  });
  const apply = () => run(() => post('apply', { ...listBody(), removeMissing }));

  // Choose the list this file updates (or '' for a new list). An existing list
  // keeps its own name; the mapping follows the choice.
  function chooseList(id) {
    setListId(id ? String(id) : '');
    const chosen = (lists.data || []).find(l => String(l.id) === String(id)) || (analysis?.existingList?.id === Number(id) ? analysis.existingList : null);
    if (mapping && chosen) setMapping({ ...mapping, listName: chosen.listName || chosen.displayName?.replace(/ \(upload\)$/, '') || mapping.listName });
    setPreview(null);
  }

  return {
    lists: lists.data || [], listsError: lists.error,
    file, setFile, listId, chooseList,
    analysis, mapping, setMapping: (m) => { setMapping(m); setPreview(null); },
    preview, removeMissing, setRemoveMissing,
    busy, error, analyze, runPreview, apply,
  };
}
