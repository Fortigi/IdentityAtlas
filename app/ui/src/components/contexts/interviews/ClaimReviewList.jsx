import { useState } from 'react';
import ChoosePersonModal from './ChoosePersonModal';
import { KIND_LABELS, RELATION_LABELS, isUncertainMatch, periodLabel, sourceLabel, subjectLabel } from './claims.helpers';

// ─── Claims waiting for review ───────────────────────────────────────────
// One row per proposed claim: its kind, who it is about (flagged when the match
// needs a look), what it says and its period, the quote (open it to read) and
// the interview. Confirm / Edit / Reject. Edit changes the value and the period
// as said, and confirms the edited claim. A role claim that would set a role but
// names nobody known asks who was meant before confirming. `decide` is the
// ClaimsProvider's: it asks before replacing an Accountable.

const BTN = 'rounded px-2 py-0.5 text-xs disabled:opacity-50';
const INPUT = 'rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

function needsPerson(claim) {
  return claim.claimKind === 'role' && !!claim.roleSuggestion && !claim.principalId && !claim.identityId;
}

// What a claim says, as one line: "Piet — does the day-to-day → Responsible".
function claimText(claim) {
  const who = subjectLabel(claim);
  const what = claim.claimKind === 'property' ? `${claim.attribute}: ${claim.value}` : claim.value;
  const relation = claim.claimKind === 'role' ? RELATION_LABELS[claim.attribute] : null;
  return [who && `${who} —`, what, relation && relation !== claim.value && `(${relation})`].filter(Boolean).join(' ');
}

function ClaimRow({ claim, decide }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(claim.value);
  const [periodText, setPeriodText] = useState(claim.periodText || '');
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run(body) {
    setBusy(true); setError(null);
    const out = await decide(claim, body);
    setBusy(false);
    if (!out.ok && !out.cancelled) setError(out.error);
    return out.ok;
  }

  const period = periodLabel(claim);
  return (
    <li className="space-y-1 py-2" data-testid="claim-review-row">
      <div className="flex flex-wrap items-baseline gap-2 text-sm text-gray-900 dark:text-gray-200">
        <span className="rounded bg-gray-100 px-1.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">{KIND_LABELS[claim.claimKind]}</span>
        <span>{claimText(claim)}</span>
        {period && <span className="text-xs text-gray-600 dark:text-gray-400">{period}</span>}
        {claim.roleSuggestion && <span className="rounded bg-blue-50 px-1.5 text-xs text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">→ {claim.roleSuggestion}</span>}
        {isUncertainMatch(claim) && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">check the person</span>}
      </div>
      {claim.quote && (
        <details className="text-xs text-gray-700 dark:text-gray-300">
          <summary className="cursor-pointer text-gray-600 dark:text-gray-400">Quote · {sourceLabel(claim)}</summary>
          <blockquote className="mt-1 border-l-2 border-gray-300 pl-2 italic dark:border-gray-600">{claim.quote}</blockquote>
        </details>
      )}
      {!claim.quote && <p className="text-xs text-gray-600 dark:text-gray-400">{sourceLabel(claim)}</p>}
      {editing ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor={`claim-value-${claim.id}`}>Value</label>
          <input id={`claim-value-${claim.id}`} className={`${INPUT} min-w-48 flex-1`} value={value} onChange={e => setValue(e.target.value)} />
          <label className="sr-only" htmlFor={`claim-period-${claim.id}`}>Period</label>
          <input id={`claim-period-${claim.id}`} className={`${INPUT} w-32`} placeholder="period, as said" value={periodText} onChange={e => setPeriodText(e.target.value)} />
          <button type="button" disabled={busy || !value.trim()} onClick={() => run({ status: 'edited', value, periodText: periodText || null })}
            className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`}>Save and confirm</button>
          <button type="button" onClick={() => setEditing(false)} className={`${BTN} text-gray-700 underline dark:text-gray-300`}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {needsPerson(claim)
            ? <button type="button" disabled={busy} onClick={() => setChoosing(true)} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`}>Choose who and confirm</button>
            : <button type="button" disabled={busy} onClick={() => run({ status: 'confirmed' })} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`}>Confirm</button>}
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className={`${BTN} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`}>Edit</button>
          <button type="button" disabled={busy} onClick={() => run({ status: 'rejected' })} className={`${BTN} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`}>Reject</button>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      {choosing && (
        <ChoosePersonModal claim={claim} title="Who is this about?" onClose={() => setChoosing(false)}
          onPick={p => run({ status: 'confirmed', principalId: p.id })} error={error} />
      )}
    </li>
  );
}

export default function ClaimReviewList({ claims, decide }) {
  if (claims.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">To review ({claims.length})</h4>
      <ul aria-label="Claims to review" className="divide-y divide-gray-100 dark:divide-gray-700">
        {claims.map(c => <ClaimRow key={c.id} claim={c} decide={decide} />)}
      </ul>
    </div>
  );
}
