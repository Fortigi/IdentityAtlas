import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useContextClaims } from './claimsContext';
import { KIND_LABELS, claimLine, periodLabel } from './claims.helpers';
import { buildTranscriptView, primaryClaimId, markClass, KIND_STYLES, STATUS_WORDS } from './transcript.helpers';

// ─── The transcript, with what was taken from it ─────────────────────────
// A side panel over the page: the interview as a dialogue (speaker column,
// their words beside it) with every claim's quote highlighted — a colour per
// kind of claim, the fill for its status (light and dashed while proposed,
// solid once confirmed, grey and struck through when rejected); a legend says
// which is which. A highlight is a button: it opens the claim card (kind,
// person, what it says, status, Confirm / Reject while proposed). `focus`
// ({ claimId, at }) scrolls to that claim's quote and makes it pulse — the
// review list, the members lists and What we know open the panel this way.
//
// The spans come from the API (GET …/interviews/:id → highlights); claims are
// the ClaimsProvider's, so a decision here shows everywhere. Analysts only.
// A long transcript renders TURN_PAGE turns at a time ("Show more"), always as
// far as the focused quote.

export const TURN_PAGE = 2000;
export const PULSE_MS = 1600;

function Legend() {
  return (
    <div aria-label="Legend" role="group" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-700 dark:text-gray-300">
      {Object.keys(KIND_STYLES).map(kind => (
        <span key={kind} className="inline-flex items-center gap-1">
          <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${KIND_STYLES[kind].swatch}`} />{KIND_LABELS[kind]}
        </span>
      ))}
      <span className="inline-flex items-center gap-2 border-l border-gray-200 pl-3 dark:border-gray-600">
        <mark className={`${markClass('role', 'proposed')} rounded px-1`}>proposed</mark>
        <mark className={`${markClass('role', 'confirmed')} rounded px-1`}>confirmed</mark>
        <mark className={`${markClass('role', 'rejected')} rounded px-1`}>rejected</mark>
      </span>
    </div>
  );
}

function ClaimCard({ claim, decide }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function run(status) {
    setBusy(true); setError(null);
    const out = await decide(claim, { status });
    setBusy(false);
    if (!out.ok && !out.cancelled) setError(out.error);
  }
  const needsPerson = claim.claimKind === 'role' && claim.roleSuggestion && !claim.principalId && !claim.identityId;
  const period = periodLabel(claim);
  return (
    <li className="space-y-1 py-1.5" data-testid="transcript-claim-card">
      <div className="flex flex-wrap items-baseline gap-2 text-sm text-gray-900 dark:text-gray-100">
        <span className={`rounded px-1.5 text-xs ${markClass(claim.claimKind, 'confirmed')}`}>{KIND_LABELS[claim.claimKind] || claim.claimKind}</span>
        <span>{claimLine(claim)}</span>
        {period && <span className="text-xs text-gray-600 dark:text-gray-400">{period}</span>}
        <span className="text-xs text-gray-600 dark:text-gray-400">{STATUS_WORDS[claim.status] || claim.status}</span>
      </div>
      {claim.status === 'proposed' && (needsPerson
        ? <p className="text-xs text-gray-600 dark:text-gray-400">Choose who this is about in the review list.</p>
        : (
          <div className="flex gap-1.5">
            <button type="button" disabled={busy} onClick={() => run('confirmed')} className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600">Confirm</button>
            <button type="button" disabled={busy} onClick={() => run('rejected')} className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">Reject</button>
          </div>
        ))}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </li>
  );
}

function Piece({ piece, claimsById, spans, pulsing, onSelect }) {
  const known = piece.claimIds.filter(id => claimsById.has(id));
  if (known.length === 0) return piece.text;
  const primary = claimsById.get(primaryClaimId(known, spans));
  const label = known.map(id => {
    const c = claimsById.get(id);
    return `${KIND_LABELS[c.claimKind] || c.claimKind}, ${STATUS_WORDS[c.status] || c.status}: ${claimLine(c)}`;
  }).join('; ');
  const pulse = known.includes(pulsing) ? ' animate-pulse ring-2 ring-blue-500 dark:ring-blue-300' : '';
  const select = () => onSelect(known);
  return (
    <mark role="button" tabIndex={0} aria-label={label} data-claim-ids={known.join(' ')}
      onClick={select} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } }}
      className={`cursor-pointer rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${markClass(primary.claimKind, primary.status)}${known.length > 1 ? ' outline outline-1 outline-gray-400' : ''}${pulse}`}>
      {piece.text}
    </mark>
  );
}

// How many turns to render: a page, and always as far as the focused quote.
function turnsToShow(turns, spans, focusId, pages) {
  const at = focusId ? spans.get(focusId)?.start : undefined;
  const focusTurn = at === undefined ? -1 : turns.findIndex(t => t.end >= at);
  return Math.max(TURN_PAGE * pages, focusTurn + 50);
}

export default function TranscriptPanel({ interviewId, focus, onClose }) {
  const ctx = useContextClaims();
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(`/api/contexts/${ctx.contextId}/interviews/${interviewId}`, { authFetch });
  const bodyRef = useRef(null);
  const dialogRef = useRef(null);
  const [selected, setSelected] = useState(() => (focus?.claimId ? [focus.claimId] : []));
  const [pulsing, setPulsing] = useState(null);
  const [pages, setPages] = useState(1);

  const claimsById = useMemo(() => new Map(ctx.claims.map(c => [c.id, c])), [ctx.claims]);
  const spans = useMemo(() => new Map((data?.highlights || []).map(h => [h.claimId, h])), [data]);
  const turns = useMemo(() => buildTranscriptView(data?.transcript, data?.highlights), [data]);
  const shown = turnsToShow(turns, spans, focus?.claimId, pages);

  // Keyboard users land in the panel; Escape closes it.
  useEffect(() => { dialogRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Scroll to the focused quote and pulse it, once the transcript is there.
  useEffect(() => {
    const id = focus?.claimId;
    if (!id || !data) return undefined;
    const el = bodyRef.current?.querySelector(`[data-claim-ids~="${id}"]`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const start = setTimeout(() => { setSelected([id]); setPulsing(id); }, 0);
    const stop = setTimeout(() => setPulsing(null), PULSE_MS);
    return () => { clearTimeout(start); clearTimeout(stop); };
  }, [focus, data]);

  const interview = data || ctx.interviews.find(i => i.id === interviewId);
  const cards = selected.map(id => claimsById.get(id)).filter(Boolean);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 dark:bg-black/60" onClick={onClose}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Transcript" onClick={e => e.stopPropagation()}
        className="flex h-full w-full max-w-3xl flex-col outline-none border-l border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="space-y-2 border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Transcript</h3>
              {interview && <p className="text-xs text-gray-600 dark:text-gray-400">Interview with {interview.intervieweeName}, {interview.interviewedAt}{interview.fileName ? ` · ${interview.fileName}` : ''}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close transcript" className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">✕</button>
          </div>
          <Legend />
        </div>
        <div ref={bodyRef} className="flex-1 overflow-auto px-5 py-3" data-testid="transcript-body">
          {loading && <p className="text-sm text-gray-600 dark:text-gray-400">Loading the transcript…</p>}
          {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">The transcript could not be loaded ({String(error.message || error)}).</p>}
          {data && (
            <div className="grid grid-cols-[minmax(0,8rem)_1fr] gap-x-3 gap-y-1.5 text-sm leading-relaxed">
              {turns.slice(0, shown).map(turn => (
                <div key={turn.index} className="contents" data-testid="transcript-turn">
                  <div className="truncate text-xs font-semibold text-gray-700 dark:text-gray-300" title={turn.speaker || undefined}>{turn.speaker}</div>
                  <div className="whitespace-pre-wrap text-gray-900 dark:text-gray-100">
                    {turn.pieces.map(p => <Piece key={p.start} piece={p} claimsById={claimsById} spans={spans} pulsing={pulsing} onSelect={setSelected} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {data && turns.length > shown && (
            <button type="button" onClick={() => setPages(n => n + 1)} className="mt-3 text-xs text-blue-700 underline dark:text-blue-300">
              Show more ({turns.length - shown} more turns)
            </button>
          )}
        </div>
        {cards.length > 0 && (
          <div className="max-h-56 overflow-auto border-t border-gray-200 bg-gray-50 px-5 py-2 dark:border-gray-700 dark:bg-gray-900/40">
            <ul aria-label="Selected claims" className="divide-y divide-gray-200 dark:divide-gray-700">
              {cards.map(c => <ClaimCard key={c.id} claim={c} decide={ctx.decide} />)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
