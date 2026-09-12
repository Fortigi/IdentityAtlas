import { useState, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';

// ─── useFeatureToggle ────────────────────────────────────────────────────
// The action behind every admin feature-flag switch (Risk Scoring,
// Experimental): flips one flag through POST /api/admin/features/toggle.
// Paired with adminUi's FeatureToggleCard, which draws the switch.
//
// On success the page is hard-reloaded rather than re-fetched: a flag decides
// which navigation tabs and which crawler types exist, and those are read at
// mount by components that may already be rendered. Reloading is the only way
// to be sure every one of them re-evaluates. On failure nothing reloads and the
// message is handed back for the caller to show next to its switch.
export default function useFeatureToggle(feature) {
  const { authFetch } = useAuth();
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState(null);

  const toggle = useCallback(async (enabled) => {
    setToggling(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/features/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature, enabled }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      window.location.reload();
    } catch (err) {
      setError(err.message);
      setToggling(false);
    }
  }, [authFetch, feature]);

  return { toggle, toggling, error };
}
