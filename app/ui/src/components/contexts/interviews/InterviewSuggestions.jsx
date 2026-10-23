import { useState } from 'react';
import SuggestionRow from '@ui/components/contexts/SuggestionRow';
import ChoosePersonModal from './ChoosePersonModal';
import { useContextClaims } from './claimsContext';
import { isUncertainMatch, roleSuggestions, sourceLabel, subjectLabel } from './claims.helpers';

// ─── What interviews suggest for one role, in the People block ───────────
// Under the Accountable or the Responsible role: every proposed role claim
// whose roleSuggestion is that role, as a SuggestionRow — the person, the quote
// and the interview it came from:
//   Confirm             — confirms the claim; the API sets the role with the
//                         claim as its source (and asks before replacing an
//                         Accountable — ClaimsProvider)
//   Not this person     — rejects the claim
//   Choose someone else — the person was misheard or mismatched: pick the right
//                         one; the claim is confirmed for them
// Under the Accountable, a claim in which the current Accountable says they are
// not the owner shows as a warning. Nothing outside a ClaimsProvider, and
// nothing for a reader (they are never sent proposed claims).

const quoted = (q) => (q ? `“${q}”` : null);

export default function InterviewSuggestions({ role, holders = [], label = role }) {
  const ctx = useContextClaims();
  const [choosing, setChoosing] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  if (!ctx?.canWrite) return null;

  const suggestions = roleSuggestions(ctx.claims, role);
  const doubt = role === 'Accountable' && holders.length > 0 ? ctx.accountableDoubt : null;

  async function decide(claim, body) {
    setBusy(claim.id); setError(null);
    const out = await ctx.decide(claim, body);
    setBusy(null);
    if (!out.ok && !out.cancelled) setError({ id: claim.id, message: out.error });
    return out.ok;
  }

  return (
    <>
      {doubt && (
        <p data-testid="accountable-doubt" className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          In doubt: {quoted(doubt.quote) || 'says they are not the owner'} (interview with {doubt.intervieweeName}, {doubt.interviewedAt})
        </p>
      )}
      {suggestions.map(claim => (
        <SuggestionRow key={claim.id} testId="interview-suggestion" name={subjectLabel(claim)}
          note={[quoted(claim.quote), `(${sourceLabel(claim)})`].filter(Boolean).join(' ')}
          flag={isUncertainMatch(claim) ? 'check the person' : null}
          canWrite busy={busy === claim.id}
          onConfirm={() => decide(claim, { status: 'confirmed' })}
          onReject={() => decide(claim, { status: 'rejected' })}
          onChooseOther={() => { setError(null); setChoosing(claim); }}
          error={error?.id === claim.id ? error.message : null} />
      ))}
      {choosing && (
        <ChoosePersonModal claim={choosing} title={`Who is ${label}?`} onClose={() => setChoosing(null)}
          onPick={p => decide(choosing, { status: 'confirmed', principalId: p.id })}
          error={error?.id === choosing.id ? error.message : null} />
      )}
    </>
  );
}
