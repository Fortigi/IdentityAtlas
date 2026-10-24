import { attributeLabel, friendlyLabel } from '@ui/utils/formatters';
import MatrixGroupingCell from './MatrixGroupingCell';
import MatrixHeaderRowTail from './MatrixHeaderRowTail';

// One merged header row for a single sort attribute: a corner cell spanning the
// info columns, one grouping cell per span, the access-package band placeholders
// and the right-side metadata placeholders.
export default function MatrixGroupingRow({
  row, rowIdx, infoColumnCount, users, accessPackages, isDark, onToggleCollapse, onToggleMembers, corner = null,
}) {
  return (
    <tr>
      {/* Corner cell spanning the info columns; shows which attribute this row groups */}
      <th
        colSpan={infoColumnCount}
        className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="text-[11px] text-gray-600 dark:text-gray-400 font-normal text-left">
            {rowIdx === 0 ? <div className="text-[10px]">Drag rows to reorder</div> : null}
            <div className="font-medium text-gray-600 dark:text-gray-300">{attributeLabel(row.attribute) || friendlyLabel(String(row.attribute).replace(/^ext\./, ''))}</div>
          </div>
          {/* Column-axis corner controls (legend, fold all columns) — row 0 only. */}
          {corner}
        </div>
      </th>

      {row.spans.map((span, idx) => (
        <MatrixGroupingCell
          key={idx}
          span={span}
          col={users[span.start]}
          rowIdx={rowIdx}
          onToggleCollapse={onToggleCollapse}
          onToggleMembers={onToggleMembers}
        />
      ))}

      {/* Access-package band placeholders + right metadata placeholders (#, Type, Description). */}
      <MatrixHeaderRowTail accessPackages={accessPackages} isDark={isDark} />
    </tr>
  );
}
