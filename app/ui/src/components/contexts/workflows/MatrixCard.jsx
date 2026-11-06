import { matrixHrefForUnit } from '@ui/utils/matrixFilter';

// What the matrix will show, in the unit's own terms.
function describe(attrs) {
  if (attrs.targetType === 'Resource' || attrs.targetType === 'System') {
    return 'Its resources as columns, and everyone who holds one of them as rows.';
  }
  return 'The members of this unit as rows, with everything they hold.';
}

// Action card: open the matrix scoped to this context, in a new tab (the matrix
// reads its filter from the URL when the page loads).
export default function MatrixCard({ attrs }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid="action-view-in-matrix">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">View in matrix</h4>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">{describe(attrs)}</p>
      <a href={matrixHrefForUnit(attrs)} target="_blank" rel="noopener noreferrer" title="opens in a new tab"
        className="inline-block rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
        View in matrix ↗
      </a>
    </div>
  );
}
