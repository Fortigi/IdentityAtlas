// Organisation → Import wizard: the dry run (POST /api/org-truth/runs/dry-run
// { sourceId, recipe, linkRules, mode } → report, nothing written), shared by
// the quality step and the activity step's preview.
//
//   const { busy, notice, check } = useDryRun(draft, update);
//
// The report lands in the draft (setQuality), so the quality step shows what
// the preview measured until the recipe changes. A 501 reads as the
// not-available sentence, any other failure as "The check failed: …".
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { dryRunBody, setQuality } from './wizardDraft';
import { sendJson } from './wizardApi';

export function useDryRun(draft, update) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const check = async () => {
    setNotice(null);
    setBusy(true);
    try {
      const report = await sendJson(authFetch, '/runs/dry-run', dryRunBody(draft));
      update(d => setQuality(d, report));
    } catch (e) {
      setNotice(e.notAvailable ? e.message : `The check failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return { busy, notice, check };
}
