import { useState } from 'react';
import FoldSection from '@ui/components/contexts/FoldSection';
import { closedLine, countLabel, raisedLine } from './changeRequests.helpers';

// ─── Change requests — what the source still has to change ───────────────
// A decision that overrides this unit's source (a member marked former while
// the uploaded list or synced system still lists them) shows its corrected
// picture at once; the correction the SOURCE still owes is a change request.
// Listed here, open first, in a section folded to its count. Nobody closes one
// by hand: the API resolves it when the source shows the change, and an undone
// decision withdraws it. `requests` comes from useChangeRequests (the page reads
// it once for this section and the attention line). Nothing at all while the
// unit never had a request.

export default function ChangeRequestsPanel({ id, requests, open, onOpenChange }) {
  const [showClosed, setShowClosed] = useState(false);
  const { open: pending, closed } = requests;
  if (pending.length === 0 && closed.length === 0) return null;

  return (
    <FoldSection id={id} title="Change requests" testId="change-requests" summary={countLabel(requests)} open={open} onOpenChange={onOpenChange}>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        What the source still has to change. Identity Atlas already shows the decision; a request closes itself when the source is corrected.
      </p>
      {pending.length > 0 && (
        <ul className="space-y-1">
          {pending.map(r => (
            <li key={r.id} className="text-sm">
              <span className="text-gray-900 dark:text-gray-100">{r.summary}</span>
              <span className="block text-xs text-gray-600 dark:text-gray-400">{raisedLine(r)}</span>
            </li>
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowClosed(v => !v)} aria-expanded={showClosed}
            className="text-xs text-blue-700 hover:underline dark:text-blue-300">
            {showClosed ? 'Hide' : 'Show'} closed ({closed.length})
          </button>
          {showClosed && (
            <ul className="mt-1 space-y-1">
              {closed.map(r => (
                <li key={r.id} className="text-sm">
                  <span className="text-gray-700 line-through decoration-gray-400 dark:text-gray-300">{r.summary}</span>
                  <span className="block text-xs text-gray-600 dark:text-gray-400">{closedLine(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </FoldSection>
  );
}
