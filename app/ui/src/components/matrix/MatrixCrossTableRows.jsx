import { attributeLabel, friendlyLabel } from '@ui/utils/formatters';
import { CORNER_ROW_H, VALUE_ROW_H } from './headerMode';
import { computeGroupingCell, spanState } from './MatrixColumnHeaders.helpers';
import MatrixHeaderRowTail from './MatrixHeaderRowTail';

// Width (px) of one subject column — the pitch the marks are spaced at.
const COL_W = 24;

// Marks. ✕ = this column carries the row's value; ▤ = the value is folded into
// one aggregate column; ▾ = the aggregate is exploded into its members.
const MARK = { value: '✕', aggregate: '▤', member: '▾' };

// One run of columns sharing this row's value. The whole run is a single control
// (one tab stop per group, as the merged cell was), carrying a mark per column.
function MarkRun({ span, mark, active, onClick, title }) {
  const marks = Array.from({ length: span.span }, (_, i) => (
    <span key={i} aria-hidden="true" className="inline-block text-center leading-none" style={{ width: `${COL_W}px` }}>{mark}</span>
  ));
  const tone = active ? 'text-indigo-800 dark:text-indigo-200' : 'text-gray-700 dark:text-gray-300';
  return (
    <th
      colSpan={span.span}
      title={title}
      className={`border-b border-r border-gray-300 dark:border-gray-600 p-0 text-center ${
        active ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'bg-gray-100 dark:bg-gray-800'
      }`}
      style={{ height: `${VALUE_ROW_H}px`, minWidth: `${span.span * COL_W}px` }}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={title}
          className={`w-full h-full flex items-center text-[10px] font-semibold cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30 ${tone}`}
        >{marks}</button>
      ) : (
        <div className={`w-full flex items-center text-[10px] font-semibold ${tone}`}>{marks}</div>
      )}
    </th>
  );
}

// The label written in the (sticky) corner area of one value row: the attribute
// name on the first row of its level, then the value itself. The very first row
// also carries the column-axis corner controls, and grows to fit them.
function RowLabel({ infoColumnCount, attribute, value, isLevelStart, isFirstRow, corner }) {
  const withCorner = isFirstRow && !!corner;
  return (
    <th
      colSpan={infoColumnCount}
      className={`sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-0 text-left font-normal ${
        isLevelStart && !isFirstRow ? 'border-t-2 border-t-gray-400 dark:border-t-gray-500' : ''
      }`}
      style={{ height: `${withCorner ? CORNER_ROW_H : VALUE_ROW_H}px` }}
    >
      <div className="flex items-center gap-2 text-[10px] leading-none">
        <span className="w-24 shrink-0 truncate text-gray-600 dark:text-gray-400">{isFirstRow ? 'Drag rows to reorder' : ''}</span>
        <span className="w-28 shrink-0 truncate font-medium text-gray-600 dark:text-gray-300">
          {isLevelStart ? (attributeLabel(attribute) || friendlyLabel(String(attribute).replace(/^ext\./, ''))) : ''}
        </span>
        <span className="truncate text-gray-700 dark:text-gray-300" title={value == null ? undefined : (value || '(none)')}>
          {value == null ? '' : (value || '(none)')}
        </span>
        {withCorner ? <span className="ml-auto flex shrink-0 items-center">{corner}</span> : null}
      </div>
    </th>
  );
}

// A folded aggregate below its fold level, or an exploded member column below
// its own level, has no value at this level: it renders once as a block cell
// spanning all of the level's value rows (carrying the child-group count).
function BlockCell({ span, col, level, rowSpan }) {
  const { showChildCount, childCount } = computeGroupingCell({ col, rowIdx: level, span });
  return (
    <th
      colSpan={span.span}
      rowSpan={rowSpan}
      className={`border-b border-r border-gray-300 dark:border-gray-600 p-0 text-center ${
        span.kind === 'aggregate' ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'bg-gray-100 dark:bg-gray-800'
      }`}
      style={{ minWidth: `${span.span * COL_W}px` }}
    >
      {showChildCount ? (
        <span className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">{childCount}</span>
      ) : null}
    </th>
  );
}

function SpanCell({ span, row, rowIdx, lvl, users, onToggleCollapse, onToggleMembers }) {
  const col = users[span.start];
  if (span.kind !== 'value') {
    return rowIdx > 0 ? null : <BlockCell span={span} col={col} level={lvl.level} rowSpan={lvl.rows.length} />;
  }
  if (span.value !== row.value) {
    return (
      <th
        colSpan={span.span}
        className="border-b border-r border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 p-0"
        style={{ height: `${VALUE_ROW_H}px`, minWidth: `${span.span * COL_W}px` }}
      />
    );
  }
  // Same click + accessible name as the rotated grouping cell at this level.
  const { aggHere, memberOwn } = spanState(col, lvl.level);
  const { onClick, title } = computeGroupingCell({ col, rowIdx: lvl.level, span, onToggleCollapse, onToggleMembers });
  const mark = aggHere ? MARK.aggregate : memberOwn ? MARK.member : MARK.value;
  return <MarkRun span={span} mark={mark} active={aggHere || memberOwn} onClick={onClick} title={title} />;
}

// The compact cross-table rendering of the grouping headers: one thin row per
// distinct value of each sort level, with a mark in every subject column that
// carries that value. Replaces the rotated merged rows when it is the shorter
// representation (see headerMode.js) — same fold/unfold semantics, a fraction of
// the vertical space.
export default function MatrixCrossTableRows({
  levels,
  users,
  infoColumnCount,
  accessPackages = [],
  isDark,
  onToggleCollapse,
  onToggleMembers,
  corner = null,
}) {
  return levels.flatMap((lvl, levelIdx) => lvl.rows.map((row, rowIdx) => (
    <tr key={`${lvl.attribute}-${levelIdx}-${rowIdx}`}>
      <RowLabel
        infoColumnCount={infoColumnCount}
        attribute={lvl.attribute}
        value={row.value}
        isLevelStart={rowIdx === 0}
        isFirstRow={levelIdx === 0 && rowIdx === 0}
        corner={corner}
      />

      {lvl.spans.map((span, spanIdx) => (
        <SpanCell
          key={spanIdx}
          span={span}
          row={row}
          rowIdx={rowIdx}
          lvl={lvl}
          users={users}
          onToggleCollapse={onToggleCollapse}
          onToggleMembers={onToggleMembers}
        />
      ))}

      <MatrixHeaderRowTail accessPackages={accessPackages} isDark={isDark} />
    </tr>
  )));
}
