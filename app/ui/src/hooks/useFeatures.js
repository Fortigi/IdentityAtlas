import { useEffect, useState } from 'react';

// ─── useFeatures ─────────────────────────────────────────────────────
// Reads the optional-feature flags (/api/features → { riskScoring,
// accountCorrelation }). Mirrors how App.jsx loads them, so detail pages
// that aren't passed `features` (e.g. UserDetailPage) can gate a tab on
// whether a feature is enabled. Defaults to enabled so a fetch failure
// doesn't hide a feature that's actually on.
export default function useFeatures() {
  const [features, setFeatures] = useState({ riskScoring: true, accountCorrelation: true });
  useEffect(() => {
    let cancelled = false;
    fetch('/api/features')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setFeatures(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return features;
}
