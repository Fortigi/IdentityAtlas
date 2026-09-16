import { GROUP_ROW_H, computeGroupingCell } from './MatrixColumnHeaders.helpers';

// One merged grouping <th> on an attribute row. Depending on its column it is a
// plain merged group, a collapsed aggregate (click to expand), a member-explode
// header (click to collapse), or a child-count cell.
export default function MatrixGroupingCell({ span, col, rowIdx, onToggleCollapse, onToggleMembers }) {
  const { onClick, title, highlight, showChildCount, childCount, label } = computeGroupingCell({
    col, rowIdx, span, onToggleCollapse, onToggleMembers,
  });
  return (
    <th
      colSpan={span.span}
      onClick={onClick}
      title={title}
      className={`border-b border-r border-gray-300 dark:border-gray-600 px-0 py-0 text-center ${
        highlight ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'bg-gray-100 dark:bg-gray-800'
      } ${onClick ? 'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30' : ''}`}
      style={{ height: `${GROUP_ROW_H}px`, minWidth: `${span.span * 24}px` }}
    >
      {showChildCount ? (
        <span className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">{childCount}</span>
      ) : (
        <div
          className={`text-[10px] font-semibold ${highlight ? 'text-indigo-800 dark:text-indigo-200' : 'text-gray-700 dark:text-gray-300'}`}
          style={{
            writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)',
            maxHeight: '110px', overflow: 'hidden', whiteSpace: 'nowrap', margin: '0 auto',
          }}
        >
          {label}
        </div>
      )}
    </th>
  );
}
