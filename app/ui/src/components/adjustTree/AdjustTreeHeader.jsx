import { formatRelativeTime } from '@ui/utils/formatters';
import { sourceText } from './adjustTree.helpers';

// The bar above the Adjust tree screen: the tree's name, where it comes from
// and when it was last refreshed, how many adjustments it carries, Refresh
// (a generated tree, for someone who may change it) and Close.

const OUTLINE_BTN = 'rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-blue-300 dark:hover:bg-blue-900/30';

export default function AdjustTreeHeader({ tree, adjustmentCount, editable, onRefresh, refreshing, onClose }) {
  const lastRun = tree.source?.lastRunAt;
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
      <h1 className="text-lg font-semibold text-gray-900 dark:text-white">{tree.name}</h1>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
        <span>{sourceText(tree)}</span>
        {lastRun && <span>Refreshed {formatRelativeTime(lastRun)}</span>}
        <span>{adjustmentCount} adjustment{adjustmentCount === 1 ? '' : 's'}</span>
        {!editable && <span>Read only</span>}
      </div>
      <div className="flex-1" />
      {editable && tree.kind === 'generated' && onRefresh && (
        <button type="button" onClick={onRefresh} disabled={refreshing} className={OUTLINE_BTN}
          title="Read the source again; your adjustments are applied again on top">
          {refreshing ? 'Refreshing…' : 'Refresh from source'}
        </button>
      )}
      {onClose && <button type="button" onClick={onClose} className={OUTLINE_BTN}>Close</button>}
    </header>
  );
}
