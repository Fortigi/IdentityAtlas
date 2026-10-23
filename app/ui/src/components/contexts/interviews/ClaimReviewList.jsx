import { useState } from 'react';
import ChoosePersonModal from './ChoosePersonModal';
import { KIND_LABELS, byRelevance, claimLine, isLowConfidence, isUncertainMatch, periodLabel, sourceLabel } from './claims.helpers';

// ─── Claims waiting for review ───────────────────────────────────────────
// One row per proposed claim: its kind, who it is about (flagged when the match
// needs a look), what it says and its period, the quote (open it to read, or
// "In transcript" to see it where it was said) and the interview. Confirm /
// Edit / Reject. Edit changes the value and the period as said, and confirms
// the edited claim. A role claim that would set a role but names nobody known
// asks who was meant before confirming. `decide` is the ClaimsProvider's: it
// asks before replacing an Accountable.
//
// What matters for access comes first; the less relevant claims (relevance
// 'low') wait folded under "Less relevant (n)". Two bulk actions clear the
// noise in one request each: "Reject all less relevant" and "Reject all
// descriptions" (rejectMany, the provider's).

const BTN = 'rounded px-2 py-0.5 text-xs disabled:opacity-50';
const INPUT = 'rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const PRIMARY = `${BTN} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`;
const SECONDARY = `${BTN} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`;
const LINK = 'text-xs text-blue-700 underline hover:text-blue-800 disabled:opacity-50 dark:text-blue-300 dark:hover:text-blue-200';

function needsPerson(claim) {
  return claim.claimKind === 'role' && !!claim.roleSuggestion && !claim.principalId && !claim.identityId;
}

function ClaimRow({ claim, decide, openTranscript }) {
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
        <span>{claimLine(claim)}</span>
        {period && <span className="text-xs text-gray-600 dark:text-gray-400">{period}</span>}
        {claim.roleSuggestion && <span className="rounded bg-blue-50 px-1.5 text-xs text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">→ {claim.roleSuggestion}</span>}
        {isUncertainMatch(claim) && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">check the person</span>}
        {isLowConfidence(claim) && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">unsure — read the quote</span>}
      </div>
      {claim.quote && (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <details className="text-xs text-gray-700 dark:text-gray-300">
            <summary className="cursor-pointer text-gray-600 dark:text-gray-400">Quote · {sourceLabel(claim)}</summary>
            <blockquote className="mt-1 border-l-2 border-gray-300 pl-2 italic dark:border-gray-600">{claim.quote}</blockquote>
          </details>
          {openTranscript && (
            <button type="button" className={LINK} onClick={() => openTranscript(claim.interviewId, claim.id)}
              aria-label={`Show “${claim.quote}” in the transcript`}>In transcript</button>
          )}
        </div>
      )}
      {!claim.quote && <p className="text-xs text-gray-600 dark:text-gray-400">{sourceLabel(claim)}</p>}
      {editing ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor={`claim-value-${claim.id}`}>Value</label>
          <input id={`claim-value-${claim.id}`} className={`${INPUT} min-w-48 flex-1`} value={value} onChange={e => setValue(e.target.value)} />
          <label className="sr-only" htmlFor={`claim-period-${claim.id}`}>Period</label>
          <input id={`claim-period-${claim.id}`} className={`${INPUT} w-32`} placeholder="period, as said" value={periodText} onChange={e => setPeriodText(e.target.value)} />
          <button type="button" disabled={busy || !value.trim()} onClick={() => run({ status: 'edited', value, periodText: periodText || null })} className={PRIMARY}>Save and confirm</button>
          <button type="button" onClick={() => setEditing(false)} className={`${BTN} text-gray-700 underline dark:text-gray-300`}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {needsPerson(claim)
            ? <button type="button" disabled={busy} onClick={() => setChoosing(true)} className={PRIMARY}>Choose who and confirm</button>
            : <button type="button" disabled={busy} onClick={() => run({ status: 'confirmed' })} className={PRIMARY}>Confirm</button>}
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className={SECONDARY}>Edit</button>
          <button type="button" disabled={busy} onClick={() => run({ status: 'rejected' })} className={SECONDARY}>Reject</button>
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

function BulkActions({ low, descriptions, rejectMany }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!rejectMany || (low === 0 && descriptions === 0)) return null;
  async function run(filter) {
    setBusy(true); setError(null);
    const out = await rejectMany(filter);
    setBusy(false);
    if (!out.ok) setError(out.error);
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {low > 0 && <button type="button" disabled={busy} className={SECONDARY} onClick={() => run({ relevance: 'low' })}>Reject all less relevant ({low})</button>}
      {descriptions > 0 && <button type="button" disabled={busy} className={SECONDARY} onClick={() => run({ kind: 'description' })}>Reject all descriptions ({descriptions})</button>}
      {error && <span role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </div>
  );
}

export default function ClaimReviewList({ claims, decide, rejectMany, openTranscript }) {
  if (claims.length === 0) return null;
  const { high, low } = byRelevance(claims);
  const descriptions = claims.filter(c => c.claimKind === 'description').length;
  const row = (c) => <ClaimRow key={c.id} claim={c} decide={decide} openTranscript={openTranscript} />;
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">To review ({claims.length})</h4>
      <BulkActions low={low.length} descriptions={descriptions} rejectMany={rejectMany} />
      {high.length > 0 && <ul aria-label="Claims to review" className="divide-y divide-gray-100 dark:divide-gray-700">{high.map(row)}</ul>}
      {low.length > 0 && (
        <details className="rounded border border-gray-100 px-2 dark:border-gray-700" data-testid="less-relevant">
          <summary className="cursor-pointer py-1 text-xs text-gray-600 dark:text-gray-400">Less relevant ({low.length})</summary>
          <ul aria-label="Less relevant claims" className="divide-y divide-gray-100 dark:divide-gray-700">{low.map(row)}</ul>
        </details>
      )}
    </div>
  );
}
