import { useState } from 'react';

// ─── useCrawlerDiscovery ─────────────────────────────────────────────────
// The "ask the endpoint what it serves" step every REST crawler wizard has.
//
// Each wizard had its own identical copy: three pieces of state, a guard so a
// second click while one is in flight does nothing, POST to that crawler's
// discover route with either a saved configId or the credentials typed so far,
// and — on any failure — fall back to an empty result plus a message, because
// discovery is an assist and must never block the wizard.
//
// What differs per crawler is only the shape of an empty result and the wording
// of the hint, so those are the parameters.
//
//   buildConfig()  returns the inline config to discover with (a fresh wizard);
//                  ignored when configId is set, since the server can then read
//                  the vaulted secret itself.
export default function useCrawlerDiscovery({ authFetch, crawlerType, configId, buildConfig, emptyResult, errorHint }) {
  const [disco, setDisco] = useState(null);
  const [discoLoading, setDiscoLoading] = useState(false);
  const [discoError, setDiscoError] = useState(null);

  // `force` re-runs a discovery that already produced a result — the wizard's
  // "Re-run discovery" button. Without it, arriving back on the step is a no-op.
  const fetchDiscovery = async ({ force = false } = {}) => {
    if (discoLoading || (disco !== null && !force)) return;
    setDiscoLoading(true);
    setDiscoError(null);
    try {
      const body = configId ? { configId } : { config: buildConfig() };
      const r = await authFetch(`/api/admin/crawlers/${crawlerType}/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setDisco(await r.json());
      } else {
        const e = await r.json().catch(() => ({}));
        setDisco(emptyResult);
        setDiscoError(e.error || errorHint);
      }
    } catch {
      setDisco(emptyResult);
      setDiscoError(errorHint);
    } finally {
      setDiscoLoading(false);
    }
  };

  return { disco, discoLoading, discoError, fetchDiscovery };
}
