import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDateOnly } from '@ui/utils/formatters';
import { Chevron } from '@ui/components/contexts/FoldSection';
import WayChips from '@ui/components/businessRoles/WayChips';
import { splitHolders, HOLDERS_LOST_DAYS } from './reviewSteps';

// ─── Who has the role, and who lost it recently ──────────────────────────
// One click away from the lifecycle step: the rules are easier to judge beside
// the people they produced. Loaded only when opened. The rows are the People
// list's (/api/access-package/:id/assignments), which keeps the people who lost
// the role as history.

const MUTED = 'text-xs text-gray-600 dark:text-gray-400';
const SHOWN = 100;

function People({ title, rows, empty, lost = false }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold text-gray-900 dark:text-gray-100">{title} ({rows.length})</h4>
      {rows.length === 0 ? <p className={MUTED}>{empty}</p> : (
        <ul className="max-h-64 divide-y divide-gray-100 overflow-auto rounded border border-gray-200 dark:divide-gray-700/50 dark:border-gray-700">
          {rows.slice(0, SHOWN).map(r => (
            <li key={r.principalId} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 text-sm text-gray-800 dark:text-gray-200">
              <span>{r.targetDisplayName || r.targetUPN || r.principalId}</span>
              {lost
                ? <span className={MUTED}>lost it on {formatDateOnly(r.deletedAt)}</span>
                : <WayChips ways={r.howHeld} direction="in" />}
            </li>
          ))}
        </ul>
      )}
      {rows.length > SHOWN && <p className={`${MUTED} mt-1`}>The first {SHOWN} of {rows.length}. The role's People list has them all.</p>}
    </div>
  );
}

export default function HoldersPanel({ roleId }) {
  const { authFetch } = useAuth();
  const [open, setOpen] = useState(false);
  const { data, loading, error } = useFetch(`/api/access-package/${encodeURIComponent(roleId)}/assignments`, { authFetch, enabled: open, initialData: [] });
  const { current, lost } = splitHolders(Array.isArray(data) ? data : []);
  return (
    <section aria-label="Who has this role" className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-2 text-left text-sm font-medium text-blue-700 hover:text-blue-600 dark:text-blue-300">
        <Chevron open={open} />
        See who has this role now, and who lost it recently
      </button>
      {open && (
        <div className="mt-3">
          {loading && <p className={MUTED}>Loading the people…</p>}
          {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">Could not load the people.</p>}
          {!loading && !error && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <People title="Have it now" rows={current} empty="Nobody holds this role." />
              <People title={`Lost it in the last ${HOLDERS_LOST_DAYS} days`} rows={lost} empty="Nobody lost this role recently." lost />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
