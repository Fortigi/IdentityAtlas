// Small presentational pieces the Organisation panels share: status and type
// pills, the loading / failed / "not available yet" panel states, and the table
// header cell. One file so the four panels and the detail page stay identical
// (and jscpd has nothing to flag).
import EmptyState from '@ui/components/EmptyState';
import { isNotAvailable, statusPillClass } from './orgFormat';

export const TH = 'px-3 py-2 text-left text-xs font-medium text-gray-600 dark:text-gray-400';
export const TD = 'px-3 py-2 align-top text-sm text-gray-700 dark:text-gray-300';
export const CARD = 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg';
export const LINK_BUTTON = 'font-medium text-blue-700 dark:text-blue-300 hover:underline text-left';
export const SMALL_BUTTON = 'text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50';
export const INPUT = 'border border-gray-200 bg-white rounded px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500';

export function StatusPill({ status }) {
  if (!status) return null;
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs ${statusPillClass(status)}`}>{status}</span>;
}

export function TypePill({ type }) {
  if (!type) return null;
  return (
    <span className="inline-block px-2 py-0.5 rounded text-xs bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300">
      {type}
    </span>
  );
}

// Loading, failed or not-built state of a useFetch result; renders nothing when
// the data is in. Callers render it when `fetchBlocked(state)` is true.
export function FetchState({ state, what }) {
  const { loading, error, data } = state;
  if (error && isNotAvailable(error)) {
    return (
      <EmptyState
        title={`${what} — not available yet`}
        hint="This part of the organisation truth is not available on this server yet."
      />
    );
  }
  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
        Could not load {what.toLowerCase()}: {error.message}
      </div>
    );
  }
  if (loading && data == null) {
    return <div className="p-6 text-center text-sm text-gray-600 dark:text-gray-400">Loading {what.toLowerCase()}…</div>;
  }
  return null;
}

// A sentence about a failed action, shown inline above the rows it concerns.
export function InlineError({ message }) {
  if (!message) return null;
  return (
    <div role="alert" className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
      {message}
    </div>
  );
}
