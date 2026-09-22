// The matrix tab with no matrix on screen: "Open a matrix" (#1202).
//
// It used to be a "Pick a slice to inspect" card with one Create button — and,
// when there was data but no org default, the app skipped it and threw the
// wizard open on arrival. A matrix is a document now, so arriving without one
// shows the documents there are: every saved matrix, one click to open, plus
// New matrix. Loading goes through savedMatrixLoadArgs, the same path as the
// name menu, so an opened matrix is tagged with where it came from.

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { formatRelativeTime } from '@ui/utils/formatters';
import { savedMatrixLoadArgs, sharedWithLabel } from './shareState';
import { lastChangedLine } from './matrixHistoryText';

const CARD = 'border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-10 bg-white dark:bg-gray-800';

function NoData() {
  return (
    <div className={`${CARD} text-center`}>
      <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-1">No data available yet</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-xl mx-auto">
        Run a crawler first to import users and resources. Once data is loaded you can build a matrix here.
      </p>
    </div>
  );
}

function SavedMatrixItem({ row, onOpen }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50"
        title={row.description || row.name}
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{row.name}</span>
            {row.isDefault && (
              <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">org default</span>
            )}
          </span>
          {row.shared && (
            <span className="block text-[11px] text-blue-700 dark:text-blue-300">{sharedWithLabel(row.recipientCount)}</span>
          )}
        </span>
        {/* Who last moved this matrix, not just when: a matrix that stopped
            producing rows is somebody's change, and that somebody is who to ask. */}
        {row.updatedAt && (
          <span className="max-w-[22ch] shrink-0 truncate text-[11px] text-gray-600 dark:text-gray-400">
            {lastChangedLine(row, formatRelativeTime(row.updatedAt))}
          </span>
        )}
      </button>
    </li>
  );
}

function SavedMatrices({ rows, loading, onOpen }) {
  if (loading && rows.length === 0) {
    return <p className="text-sm text-gray-600 dark:text-gray-400">Loading saved matrices…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Nobody has saved a matrix yet. A matrix compares a chosen set of users or identities with a
        chosen set of resources — start a new one, and give it a name at the end to keep it.
      </p>
    );
  }
  return (
    <ul aria-label="Saved matrices" className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
      {rows.map(row => <SavedMatrixItem key={row.id} row={row} onOpen={onOpen} />)}
    </ul>
  );
}

function OpenList({ onLoad, onNew }) {
  const { authFetch } = useAuth();
  const { data, loading } = useFetch('/api/matrix/saved-filters', {
    authFetch,
    initialData: [],
    transform: rows => (Array.isArray(rows) ? rows : []),
  });
  const rows = data || [];

  return (
    <section aria-labelledby="open-matrix-heading" className={CARD}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="open-matrix-heading" className="text-base font-semibold text-gray-800 dark:text-gray-200">Open a matrix</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">Pick a saved matrix, or start a new one.</p>
        </div>
        <button
          type="button"
          onClick={() => onNew?.()}
          className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600"
        >
          New matrix
        </button>
      </div>
      <SavedMatrices rows={rows} loading={loading} onOpen={row => onLoad?.(...savedMatrixLoadArgs(row))} />
    </section>
  );
}

export default function OpenMatrixList({ hasData, onLoad, onNew }) {
  // A share recipient never lands here without a matrix, and must not be shown
  // (or fetch) the org's saved matrices if they somehow did.
  if (useIsSharedView()) return null;
  if (hasData === false) return <NoData />;
  if (hasData === null) return null;
  return <OpenList onLoad={onLoad} onNew={onNew} />;
}
