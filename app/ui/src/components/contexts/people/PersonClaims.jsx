import { useState } from 'react';
import { useContextClaims } from '@ui/components/contexts/interviews/claimsContext';
import { claimLine, periodLabel, sourceLabel } from '@ui/components/contexts/interviews/claims.helpers';
import { STATUS_WORDS } from '@ui/components/contexts/interviews/transcript.helpers';
import { RULE_TITLES } from '@ui/components/contexts/interviews/contradiction.helpers';
import { Side, Choices } from '@ui/components/contexts/interviews/Contradictions';
import ClaimDecision from '@ui/components/contexts/interviews/ClaimDecision';
import ClaimIcon from './ClaimIcon';
import { claimIcons, personContradictions, truncate } from './people.helpers';

// ─── What the sources say about one person, as icons on their row ────────
// One icon per kind of claim (role, membership, history): outlined and dashed
// while a claim of that kind is proposed, solid once confirmed. Its popover says
// each claim in one line, the quote (cut at about 200 characters), where it comes
// from, and its status; an analyst gets Confirm / Reject there (the same decide()
// the review list uses) and "Show in the source", and a click on the icon opens
// the source at the first claim's quote. A person in an open contradiction gets a
// warning icon whose popover shows both statements and the decision buttons
// (Contradictions.jsx's Side and Choices). The claim a decision marked the person
// former on carries Undo decision. A reader sees confirmed claims only (the API
// decides) and no buttons.

const GLYPH = { role: 'role', membership: 'membership', history: 'history' };

// What the claim says without the person — the row already names them.
const whatItSays = (c) => claimLine({ ...c, subjectDisplayName: null, subjectName: null });

// The claim a decision marked the person former on: an analyst may undo that
// decision here (the claim is proposed again, the person current again).
function UndoDecision({ claimId, undo }) {
  const [error, setError] = useState(null);
  async function run() {
    setError(null);
    const out = await undo(claimId);
    if (!out.ok) setError(out.error);
  }
  return (
    <>
      <button type="button" onClick={run} className="text-xs text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">Undo decision</button>
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </>
  );
}

function ClaimLines({ claims, ctx, decisionClaimId }) {
  return (
    <ul className="space-y-2 divide-y divide-gray-100 dark:divide-gray-700">
      {claims.map(c => {
        const period = periodLabel(c);
        return (
          <li key={c.id} className="space-y-1 pt-2 first:pt-0" data-testid="person-claim">
            <p className="text-sm text-gray-900 dark:text-gray-100">{whatItSays(c)}{period && <span className="text-xs text-gray-600 dark:text-gray-400"> · {period}</span>}</p>
            {c.quote && <blockquote className="border-l-2 border-gray-300 pl-2 text-xs italic text-gray-700 dark:border-gray-600 dark:text-gray-300">“{truncate(c.quote)}”</blockquote>}
            <p className="text-xs text-gray-600 dark:text-gray-400">{sourceLabel(c)} · {STATUS_WORDS[c.status] || c.status}</p>
            {ctx?.canWrite && <ClaimDecision claim={c} decide={ctx.decide} label={whatItSays(c)} />}
            {ctx?.canWrite && c.id === decisionClaimId && <UndoDecision claimId={c.id} undo={ctx.undo} />}
            {ctx?.openTranscript && c.interviewId && (
              <button type="button" onClick={() => ctx.openTranscript(c.interviewId, c.id)}
                className="text-xs text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">Show in the source</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ContradictionBody({ con, ctx }) {
  return (
    <>
      <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">{RULE_TITLES[con.rule] || con.rule}</p>
      <Side side={con.claim} label="claim" openTranscript={ctx.openTranscript} />
      <Side side={con.other} label="other" openTranscript={ctx.openTranscript} />
      {ctx.canWrite ? <Choices con={con} decide={ctx.decide} /> : <p className="text-xs text-gray-600 dark:text-gray-400">An analyst decides which is right.</p>}
    </>
  );
}

export default function PersonClaims({ person }) {
  const ctx = useContextClaims();
  const icons = claimIcons(person);
  const open = personContradictions(person, ctx?.contradictions);
  if (icons.length === 0 && open.length === 0) return null;
  const openSource = (c) => (ctx?.openTranscript && c.interviewId ? () => ctx.openTranscript(c.interviewId, c.id) : undefined);
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="person-claims">
      {open.map(con => (
        <ClaimIcon key={con.id} glyph="warning" variant="warning" testId="person-contradiction"
          label={`To decide for ${person.displayName}: ${RULE_TITLES[con.rule] || con.rule}`}>
          <ContradictionBody con={con} ctx={ctx} />
        </ClaimIcon>
      ))}
      {icons.map(icon => (
        <ClaimIcon key={icon.key} glyph={GLYPH[icon.key]} variant={icon.state} testId={`person-claim-${icon.key}`}
          label={`${icon.label} — ${icon.claims.length === 1 ? whatItSays(icon.claims[0]) : `${icon.claims.length} claims`} (${icon.state === 'proposed' ? 'to review' : 'confirmed'})`}
          onActivate={openSource(icon.claims[0])}>
          <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{icon.label}</p>
          <ClaimLines claims={icon.claims} ctx={ctx} decisionClaimId={person.decision?.claimId} />
        </ClaimIcon>
      ))}
    </span>
  );
}
