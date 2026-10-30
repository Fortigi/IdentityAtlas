import { useState } from 'react';
import { useContextClaims } from './claimsContext';
import { aliasFacts, sourceLabel } from './claims.helpers';
import { factTitle } from './memberInterview.helpers';

// ─── "Also known as" — a fact of the unit's / application's profile ─────
// The context's other names: confirmed ones plain (extendedAttributes.aliases,
// and confirmed alias claims), PROPOSED ones from the interviews dashed and
// italic with a one-click Confirm / Reject — for an analyst only; a reader is
// sent confirmed claims only and gets no buttons. Confirming goes through the
// ClaimsProvider's decide(), which re-reads the claims and tells the page, so
// the name turns solid without a reload. Renders a <dt>/<dd> pair inside the
// profile's facts list, or nothing when the context has no other name.

const BTN = 'rounded px-1.5 text-xs disabled:opacity-50';

function ProposedAlias({ fact, decide }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function run(status) {
    setBusy(true); setError(null);
    const out = await decide(fact.claim, { status });
    setBusy(false);
    if (!out.ok && !out.cancelled) setError(out.error);
  }
  return (
    <li className="inline-flex flex-wrap items-baseline gap-1" data-testid="alias-proposed">
      <span className="italic border-b border-dashed border-gray-400 text-gray-700 dark:border-gray-500 dark:text-gray-300"
        title={`Proposed — ${factTitle(fact.claim)}`}>{fact.name}</span>
      <button type="button" disabled={busy} onClick={() => run('confirmed')} aria-label={`Confirm “${fact.name}” as another name`}
        className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`}>Confirm</button>
      <button type="button" disabled={busy} onClick={() => run('rejected')} aria-label={`Reject “${fact.name}”`}
        className={`${BTN} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`}>Reject</button>
      {error && <span role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </li>
  );
}

export default function AlsoKnownAs({ attrs }) {
  const ctx = useContextClaims();
  const canWrite = !!ctx?.canWrite;
  const facts = aliasFacts(attrs, ctx?.claims, canWrite);
  if (facts.length === 0) return null;
  return (
    <>
      <dt className="text-gray-500 dark:text-gray-400">Also known as</dt>
      <dd className="text-gray-900 dark:text-gray-200">
        <ul aria-label="Also known as" className="flex flex-wrap gap-x-3 gap-y-1">
          {facts.map(f => (f.status === 'proposed' && ctx?.decide
            ? <ProposedAlias key={f.claim.id} fact={f} decide={ctx.decide} />
            : <li key={f.name} data-testid={`alias-${f.status}`} title={f.claim ? sourceLabel(f.claim) : undefined}
                className={f.status === 'proposed' ? 'italic border-b border-dashed border-gray-400 dark:border-gray-500' : undefined}>{f.name}</li>))}
        </ul>
      </dd>
    </>
  );
}
