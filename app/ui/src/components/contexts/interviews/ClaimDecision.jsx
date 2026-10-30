import { useState } from 'react';
import { needsPerson } from './claims.helpers';

// ─── Confirm / Reject one proposed claim, where the claim is shown ────────
// The transcript view's claim card and a person's claim popover on the People
// overview both decide here, through the ClaimsProvider's decide() (which asks
// before replacing an Accountable). A role claim that would set a role but names
// nobody we hold cannot be confirmed in one click: the review list asks who was
// meant. Nothing for a claim already decided. `label` names the claim for a
// screen reader ("Confirm: Ann Example — architect").

const BTN = 'rounded px-2 py-0.5 text-xs disabled:opacity-50';
const CONFIRM_CLASS = `${BTN} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`;
const REJECT_CLASS = `${BTN} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`;

export default function ClaimDecision({ claim, decide, label }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (claim.status !== 'proposed' || !decide) return null;
  if (needsPerson(claim)) return <p className="text-xs text-gray-600 dark:text-gray-400">Choose who this is about in the review list.</p>;

  async function run(status) {
    setBusy(true); setError(null);
    const out = await decide(claim, { status });
    setBusy(false);
    if (!out.ok && !out.cancelled) setError(out.error);
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        <button type="button" disabled={busy} onClick={() => run('confirmed')} className={CONFIRM_CLASS}
          aria-label={label ? `Confirm: ${label}` : undefined}>Confirm</button>
        <button type="button" disabled={busy} onClick={() => run('rejected')} className={REJECT_CLASS}
          aria-label={label ? `Reject: ${label}` : undefined}>Reject</button>
      </div>
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
