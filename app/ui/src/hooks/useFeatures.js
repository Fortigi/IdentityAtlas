import { useEffect, useState } from 'react';

// ─── useFeatures ─────────────────────────────────────────────────────
// Reads the optional-feature flags (/api/features → { riskScoring,
// accountLinking }). Mirrors how App.jsx loads them, so detail pages
// that aren't passed `features` (e.g. UserDetailPage) can gate a tab on
// whether a feature is enabled. Account linking (on by default) starts on so a
// fetch failure doesn't hide it; risk scoring is experimental and off by default,
// so it stays hidden until the server says it is on.
export default function useFeatures() {
  const [features, setFeatures] = useState({ accountLinking: true });
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
