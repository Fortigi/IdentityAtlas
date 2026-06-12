import { getAccessPackageColor } from '../../utils/colors';
import { useIsDark } from '../../contexts/ThemeContext';
import { computeAttributeSpans } from './sortUsers';
import { friendlyLabel } from '../../utils/formatters';

export default function MatrixColumnHeaders({
  users,
  infoColumnCount,
  onSortByCount,
  accessPackages = [],
  onOpenDetail,
  expandedIdentities,
  onToggleIdentity,
  loadingIdentityCols,
  sortAttributes,
  onToggleCollapse,
}) {
  const isDark = useIsDark();

  // One merged header row per sort attribute (default: department), each
  // grouping consecutive columns that share the same value (read from each
  // user's precomputed sortKeys[index]). Columns are pre-sorted in MatrixView.
  const attrs = (Array.isArray(sortAttributes) && sortAttributes.length)
    ? sortAttributes.map(s => s.attribute)
    : ['department'];
  const attrRows = attrs.map((attribute, index) => ({ attribute, spans: computeAttributeSpans(users, index) }));
  const headerRowCount = attrRows.length;

  return (
    <thead className="sticky top-0 z-20">
      {/* One merged row per sort attribute */}
      {attrRows.map((row, rowIdx) => (
        <tr key={row.attribute + rowIdx}>
          {/* Corner cell spanning the info columns; shows which attribute this row groups */}
          <th
            colSpan={infoColumnCount}
            className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1"
          >
            <div className="text-[11px] text-gray-500 dark:text-gray-400 font-normal">
              {rowIdx === 0 ? <div className="text-[10px]">Drag rows to reorder</div> : null}
              <div className="font-medium text-gray-600 dark:text-gray-300">{friendlyLabel(String(row.attribute).replace(/^ext\./, ''))}</div>
            </div>
          </th>

          {row.spans.map((span, idx) => {
            const col = users[span.start];
            // `aggHere`: this span IS a collapsed aggregate column at-or-below its
            // fold level. At ANCESTOR levels (rowIdx < level) the span is just a
            // normal merged group (its value is the ancestor's), so treat it as
            // collapsible even though it happens to contain an aggregate column.
            const aggHere = !!col?.isAggregateCol && rowIdx >= col.level;
            const showChildCount = aggHere && rowIdx > col.level; // "6 departments"
            const collapsible = !!onToggleCollapse && !aggHere;   // normal/ancestor group
            const onClick = collapsible
              ? () => onToggleCollapse(col.sortKeys, rowIdx)
              : aggHere ? () => onToggleCollapse(col.sortKeys, col.level) : undefined;
            const title = collapsible
              ? `Collapse ${span.value || '(none)'} into one column`
              : aggHere ? `Expand ${col.value || '(none)'} back into its columns` : undefined;
            return (
              <th
                key={idx}
                colSpan={span.span}
                onClick={onClick}
                title={title}
                className={`border-b border-r border-gray-300 dark:border-gray-600 px-0 py-0 text-center ${
                  aggHere ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'bg-gray-100 dark:bg-gray-800'
                } ${onClick ? 'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30' : ''}`}
                style={{ height: '120px', minWidth: `${span.span * 24}px` }}
              >
                {showChildCount ? (
                  <span className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">{col.childCounts?.[rowIdx] ?? 0}</span>
                ) : (
                  <div
                    className={`text-[10px] font-semibold ${aggHere ? 'text-indigo-800 dark:text-indigo-200' : 'text-gray-700 dark:text-gray-300'}`}
                    style={{
                      writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)',
                      maxHeight: '110px', overflow: 'hidden', whiteSpace: 'nowrap', margin: '0 auto',
                    }}
                  >
                    {aggHere ? `▤ ${col.value || '(none)'}` : (span.value || '(none)')}
                  </div>
                )}
              </th>
            );
          })}

          {/* Access Package name headers — rendered once, spanning all header rows + the name row */}
          {rowIdx === 0 && accessPackages.map((ap, idx) => {
            const prevCat = idx > 0 ? (accessPackages[idx - 1].categoryName || null) : undefined;
            const curCat = ap.categoryName || null;
            const isCategoryBoundary = idx === 0 || prevCat !== curCat;
            return (
              <th
                key={ap.id}
                rowSpan={headerRowCount + 1}
                className={`border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center ${idx === 0 ? 'border-l-2 border-l-indigo-300 dark:border-l-indigo-500' : isCategoryBoundary ? 'border-l-2 border-l-gray-400 dark:border-l-gray-500' : ''}`}
                style={{
                  backgroundColor: getAccessPackageColor(idx, isDark),
                  width: '24px',
                  minWidth: '24px',
                  verticalAlign: 'bottom',
                }}
                title={`${ap.displayName}\nCatalog: ${ap.catalogName || ''}${ap.categoryName ? '\nCategory: ' + ap.categoryName : ''}`}
              >
                <div
                  className="text-[10px] text-gray-700 dark:text-gray-200 font-medium select-none cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                  style={{
                    writingMode: 'vertical-lr',
                    textOrientation: 'mixed',
                    transform: 'rotate(180deg)',
                    maxHeight: '210px',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    margin: '0 auto',
                  }}
                  onClick={() => onOpenDetail?.('access-package', ap.id, ap.displayName)}
                >
                  {ap.displayName}
                </div>
              </th>
            );
          })}

          {/* Right metadata column placeholders (#, Description) */}
          <th className="border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '40px' }} />
          <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '500px' }} />
        </tr>
      ))}

      {/* Final row: User names */}
      <tr>
        {/* Corner cells for row info headers */}
        <th className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-1 py-1 text-[10px] text-gray-500 dark:text-gray-400"
            style={{ minWidth: '24px' }}>
        </th>
        <th className="sticky z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 text-left font-medium"
            style={{ left: '24px', minWidth: '275px' }}>
          Resource Name
        </th>
        <th className="sticky z-30 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-left font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
            style={{ left: '299px', minWidth: '180px' }}>
          Type
        </th>

        {users.map(user => {
          // Collapsed aggregate column: the name row shows the user COUNT and an
          // expand control, instead of a single subject name.
          if (user.isAggregateCol) {
            return (
              <th key={user.id}
                className="border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center bg-indigo-50 dark:bg-indigo-900/20 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30"
                style={{ height: '100px', width: '24px', minWidth: '24px', verticalAlign: 'bottom' }}
                onClick={() => onToggleCollapse?.(user.sortKeys, user.level)}
                title={`${user.userCount} ${user.userCount === 1 ? 'user' : 'users'} — click to expand`}>
                <div className="flex flex-col items-center justify-end h-full pb-1 gap-0.5">
                  <span className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">{user.userCount}</span>
                  <span className="text-[9px] leading-none text-gray-500 dark:text-gray-400">▸</span>
                </div>
              </th>
            );
          }
          const isIdentity = user.memberType === 'Identity';
          const isAcct = !!user.isAccountCol;
          const isExpanded = expandedIdentities?.has(user.id);
          const isLoadingCol = loadingIdentityCols?.has(user.id);
          return (
            <th
              key={user.id}
              className={`border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center ${
                isAcct ? 'bg-blue-50 dark:bg-blue-900/20 border-l border-l-blue-200 dark:border-l-blue-800' : 'bg-gray-100 dark:bg-gray-800'
              }`}
              style={{ height: '100px', width: '24px', minWidth: '24px', verticalAlign: 'bottom' }}
              title={`${user.displayName}${isAcct ? ` (account${user.accountType ? ' · ' + user.accountType : ''})` : ''}\n${user.jobTitle || ''}\n${user.department || ''}`}
            >
              <div className="flex flex-col items-center justify-end h-full">
                {isIdentity && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleIdentity?.(user.id); }}
                    className="w-4 h-4 flex items-center justify-center text-[10px] leading-none text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
                    title={isExpanded ? 'Collapse accounts' : 'Expand into linked accounts'}
                  >
                    {isLoadingCol ? '⋯' : (isExpanded ? '▾' : '▸')}
                  </button>
                )}
                <div
                  className={`text-[10px] font-medium cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 ${
                    isAcct ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'
                  }`}
                  style={{
                    writingMode: 'vertical-lr',
                    textOrientation: 'mixed',
                    transform: 'rotate(180deg)',
                    maxHeight: isIdentity ? '78px' : '95px',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    margin: '0 auto',
                  }}
                  onClick={() => onOpenDetail?.(isIdentity ? 'identity' : 'user', user.id, user.displayName)}
                >
                  {isAcct && user.accountType ? `${user.displayName} · ${user.accountType}` : user.displayName}
                </div>
              </div>
            </th>
          );
        })}

        {/* Right metadata column headers row 2 — # | Description */}
        <th className="border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-1 py-1 text-[10px] text-gray-500 dark:text-gray-400 font-medium cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 select-none"
            onClick={onSortByCount}
            title="Sort by member count (descending)">
          <div style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}># &#x25BC;</div>
        </th>
        <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 font-medium text-left"
            style={{ minWidth: '500px' }}>
          Description
        </th>
      </tr>
    </thead>
  );
}
