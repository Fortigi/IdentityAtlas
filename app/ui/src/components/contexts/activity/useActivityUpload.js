import { useCallback, useState } from 'react';
import { readJson } from '@ui/components/contexts/upload/useContextUpload';

// The state and the API calls of the "Upload activity" wizard on one context:
//   analyze()  POST /api/contexts/:id/activity/analyze  (the file → columns + best guess)
//   preview()  POST /api/contexts/:id/activity/preview  (the mapping → what would happen)
//   apply()    POST /api/contexts/:id/activity/apply    (write it; resolves to the result)
// Each call sets `busy` while it runs and `error` (a sentence) when it fails —
// the same shape as the list upload's useContextUpload, whose readJson it uses.

export function useActivityUpload(authFetch, contextId) {
  const [file, setFile] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [mapping, setMappingState] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const base = `/api/contexts/${encodeURIComponent(contextId)}/activity`;

  const run = useCallback(async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (err) { setError(err.message || 'Something went wrong'); return null; } finally { setBusy(false); }
  }, []);

  const post = (path, body) => run(async () => readJson(await authFetch(`${base}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })));

  const analyze = () => run(async () => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const result = await readJson(await authFetch(`${base}/analyze`, { method: 'POST', body: fd }));
    setAnalysis(result); setMappingState(result.guess); setPreview(null);
    return result;
  });

  const runPreview = async () => {
    const result = await post('preview', { uploadDraftId: analysis.uploadDraftId, mapping });
    if (result) setPreview(result);
    return result;
  };
  const apply = () => post('apply', { uploadDraftId: analysis.uploadDraftId, mapping });

  return {
    file, setFile,
    analysis, mapping, setMapping: (m) => { setMappingState(m); setPreview(null); },
    preview, busy, error, analyze, runPreview, apply,
  };
}
