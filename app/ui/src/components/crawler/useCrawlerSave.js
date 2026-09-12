import { useState } from 'react';
import saveCrawlerConfig from './saveCrawlerConfig';

// ─── useCrawlerSave ──────────────────────────────────────────────────────
// The save half of a crawler wizard: the in-flight flag, the error message the
// WizardShell renders, and the try/catch/finally around the write.
//
// Every wizard had its own identical copy of that tail — set saving, build the
// payload, POST or PATCH, unwrap the error, call onComplete, clear saving in a
// finally. Only the payload differs, so that is all the caller passes.
//
//   const { save, saving, error } = useCrawlerSave({ authFetch, crawlerType: 'scim', configId, onComplete });
//   <button onClick={() => save(displayName, buildConfig())} disabled={saving}>
export default function useCrawlerSave({ authFetch, crawlerType, configId, onComplete }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async (displayName, config) => {
    setSaving(true);
    setError(null);
    try {
      await saveCrawlerConfig({ authFetch, crawlerType, configId, displayName, config });
      onComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return { save, saving, error, setError };
}
