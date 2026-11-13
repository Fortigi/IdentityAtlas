import { useState } from 'react';
import { useContextClaims } from './claimsContext';
import { decisionsFor, isPersonContradiction, openContradictions, panelId, RULE_TITLES, withPeriod } from './contradiction.helpers';
import { periodLabel, sourceLabel } from './claims.helpers';

// ─── Contradictions — what an interview says against what we hold ────────
// A claim that only adds knowledge keeps the ordinary review. One that
// disagrees — "Lotte left" while the uploaded list still has her, another owner
// than the Accountable, another value than the attribute, two interviews that
// say different things — is shown here as a PAIR: the claim with its interview
// and quote (View in transcript), and beside it the fact it contradicts with its
// source (or the other claim). An analyst decides with an explicit choice; the
// choice is made by deciding the claim(s) (contradiction.helpers.js), so a
// decided one leaves this panel and shows on the Timeline as "Decided: …". A
// reader sees the open ones, without buttons. The API finds them
// (GET …/claims → contradictions); this only shows and decides.
//
// On a unit's page a contradiction about a person is decided on that person's
// row in People (Side and Choices are shared with its popover); this panel, in
// What we know, keeps the ones about the unit itself (`unitOnly`).

const BTN = 'rounded px-2 py-0.5 text-xs disabled:opacity-50';
const PRIMARY = `${BTN} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`;
const SECONDARY = `${BTN} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`;
const INPUT = 'rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

export function Side({ side, label, openTranscript }) {
  const c = side.kind === 'claim' ? side.claim : null;
  const period = c ? periodLabel(c) : '';
  return (
    <div className="space-y-1 rounded border border-gray-200 p-2 dark:border-gray-700" data-testid={`contradiction-${label}`}>
      <p className={`text-sm text-gray-900 dark:text-gray-100${c?.status === 'proposed' ? ' italic' : ''}`}>{side.statement}</p>
      {c ? (
        <>
          <p className="text-xs text-gray-600 dark:text-gray-400">{sourceLabel(c)}{period ? ` · ${period}` : ''}</p>
          {c.quote && <blockquote className="border-l-2 border-gray-300 pl-2 text-xs italic text-gray-700 dark:border-gray-600 dark:text-gray-300">{c.quote}</blockquote>}
          {openTranscript && c.interviewId && (
            <button type="button" onClick={() => openTranscript(c.interviewId, c.id)}
              className="text-xs text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">View in transcript</button>
          )}
        </>
      ) : (
        <p className="text-xs text-gray-600 dark:text-gray-400">Source: {side.source}</p>
      )}
    </div>
  );
}

export function Choices({ con, decide }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [askPeriod, setAskPeriod] = useState(null);
  const [period, setPeriod] = useState('');
  const choices = decisionsFor(con);
  if (choices.length === 0) return null;

  async function run(choice) {
    if (choice.needsPeriod && askPeriod !== choice.key) { setAskPeriod(choice.key); return; }
    setBusy(true); setError(null);
    for (const s of withPeriod(choice, period)) {
      const out = await decide(s.claim, s.body);
      if (!out.ok) { setBusy(false); if (!out.cancelled) setError(out.error); return; }
    }
    setBusy(false);
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1.5">
        {choices.map((choice, i) => (
          <button key={choice.key} type="button" disabled={busy} title={choice.hint || undefined}
            className={i === 0 ? PRIMARY : SECONDARY} onClick={() => run(choice)}>{choice.label}</button>
        ))}
      </div>
      {choices[0].hint && <p className="text-xs text-gray-600 dark:text-gray-400">{choices[0].hint}</p>}
      {askPeriod && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="text-xs text-gray-700 dark:text-gray-300" htmlFor={`period-${con.id}`}>When was the interview's statement true?</label>
          <input id={`period-${con.id}`} className={`${INPUT} w-40`} placeholder="e.g. until 2025" value={period} onChange={e => setPeriod(e.target.value)} />
          <button type="button" disabled={busy || !period.trim()} className={PRIMARY}
            onClick={() => run(choices.find(c => c.key === askPeriod))}>Save</button>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}

export default function Contradictions({ unitOnly = false }) {
  const ctx = useContextClaims();
  const open = openContradictions(ctx?.contradictions).filter(c => !unitOnly || !isPersonContradiction(c));
  if (!ctx || open.length === 0) return null;
  return (
    <section id={panelId(ctx.contextId)} aria-label="Contradictions" className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/20">
      <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Contradictions ({open.length})</h4>
      <p className="text-xs text-amber-900 dark:text-amber-200">These statements disagree. {ctx.canWrite ? 'Decide which is right.' : 'An analyst decides which is right.'}</p>
      <ul className="space-y-3">
        {open.map(con => (
          <li key={con.id} className="space-y-1.5 rounded bg-white p-2 dark:bg-gray-800" data-testid="contradiction">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{RULE_TITLES[con.rule] || con.rule}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Side side={con.claim} label="claim" openTranscript={ctx.openTranscript} />
              <Side side={con.other} label="other" openTranscript={ctx.openTranscript} />
            </div>
            {ctx.canWrite && <Choices con={con} decide={ctx.decide} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
