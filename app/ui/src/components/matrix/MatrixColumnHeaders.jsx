import { getAccessPackageColor } from '@ui/utils/colors';
import { useIsDark } from '@ui/contexts/ThemeContext';
import { computeAttributeSpans } from './sortUsers';
import { friendlyLabel } from '@ui/utils/formatters';
import { GROUP_ROW_H, apBandBorderClass, buildCrossRows, computeHeaderMode, crossGroupingHeight, spanInteraction } from './headerMode';
import MatrixCrossTableRows from './MatrixCrossTableRows';
import MatrixHeaderRowTail from './MatrixHeaderRowTail';

export { GROUP_ROW_H };

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
  onToggleMembers,
  maxHeaderDepth,
  headerMode,
}) {
  const isDark = useIsDark();

  // One grouping header level per sort attribute (default: department), each
  // grouping consecutive columns that share the same value (read from each
  // user's precomputed sortKeys[index]). In hierarchy sort, maxHeaderDepth caps
  // the levels to the unfolded depth so the next org level only appears once a
  // group is expanded into it.
  const attrs = (Array.isArray(sortAttributes) && sortAttributes.length)
    ? sortAttributes.map(s => s.attribute)
    : ['department'];
  const shown = (typeof maxHeaderDepth === 'number' && maxHeaderDepth > 0)
    ? Math.min(maxHeaderDepth, attrs.length) : attrs.length;
  const attrRows = attrs.slice(0, shown).map((attribute, index) => ({ attribute, level: index }));

  // Cross-table mode renders each level as thin per-value rows instead of one
  // tall rotated row — far shorter on the small screens the grid has to fit. The
  // mode comes from the caller (MatrixView), which derives it from the matrix
  // DEFINITION so folding a group never re-styles the header under the click;
  // standalone callers fall back to deciding it from what they render.
  const mode = headerMode || computeHeaderMode(users, shown);
  const crossLevels = mode === 'cross'
    ? attrRows.map(row => ({ ...row, ...buildCrossRows(users, row.level) }))
    : null;
  const rotatedRows = crossLevels
    ? []
    : attrRows.map(row => ({ ...row, spans: computeAttributeSpans(users, row.level) }));

  // Keep only the final (names) row pinned on vertical scroll — the attribute
  // grouping rows above it scroll away, so many sort attributes don't bury the
  // grid. We do this by making the whole <thead> sticky with a NEGATIVE `top`
  // equal to the combined height of the grouping rows: as you scroll, those
  // rows slide up out of view and the names row comes to rest at top:0.
  //
  // This must be done on the <thead> — not on the individual last-row cells.
  // A sticky table *cell* is constrained to its section's box, so once the
  // <thead> scrolls past by more than the grouping-rows' height the pinned
  // cell escapes upward and leaves a blank (grey) band where the header was
  // (issue: multi-header matrix "grey area" on scroll). A sticky <thead> is
  // constrained to the whole table instead, so it stays pinned through the
  // entire body scroll.
  const groupingOffset = crossLevels ? crossGroupingHeight(crossLevels) : attrRows.length * GROUP_ROW_H;
  return (
    <thead className="sticky z-30" style={{ top: `-${groupingOffset}px` }}>
      {crossLevels ? (
        <MatrixCrossTableRows
          levels={crossLevels}
          users={users}
          infoColumnCount={infoColumnCount}
          accessPackages={accessPackages}
          onToggleCollapse={onToggleCollapse}
          onToggleMembers={onToggleMembers}
        />
      ) : null}

      {/* Rotated fallback: one merged row per sort attribute */}
      {rotatedRows.map((row, rowIdx) => (
        <tr key={row.attribute + rowIdx}>
          {/* Corner cell spanning the info columns; shows which attribute this row groups */}
          <th
            colSpan={infoColumnCount}
            className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1"
          >
            <div className="text-[11px] text-gray-600 dark:text-gray-400 font-normal">
              {rowIdx === 0 ? <div className="text-[10px]">Drag rows to reorder</div> : null}
              <div className="font-medium text-gray-600 dark:text-gray-300">{friendlyLabel(String(row.attribute).replace(/^ext\./, ''))}</div>
            </div>
          </th>

          {row.spans.map((span, idx) => {
            // What this span means at this level (aggregate / member-exploded /
            // a plain collapsible group) and the click + tooltip it carries —
            // shared with the cross-table rendering so the two can't drift.
            const { col, aggHere, showChildCount, memberOwn, onClick, title } =
              spanInteraction(users, span, rowIdx, { onToggleCollapse, onToggleMembers });
            return (
              <th
                key={idx}
                colSpan={span.span}
                onClick={onClick}
                title={title}
                className={`border-b border-r border-gray-300 dark:border-gray-600 px-0 py-0 text-center ${
                  aggHere || memberOwn ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'bg-gray-100 dark:bg-gray-800'
                } ${onClick ? 'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30' : ''}`}
                style={{ height: `${GROUP_ROW_H}px`, minWidth: `${span.span * 24}px` }}
              >
                {showChildCount ? (
                  <span className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">{col.childCounts?.[rowIdx] ?? 0}</span>
                ) : (
                  <div
                    className={`text-[10px] font-semibold ${aggHere || memberOwn ? 'text-indigo-800 dark:text-indigo-200' : 'text-gray-700 dark:text-gray-300'}`}
                    style={{
                      writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)',
                      maxHeight: '110px', overflow: 'hidden', whiteSpace: 'nowrap', margin: '0 auto',
                    }}
                  >
                    {aggHere ? `▤ ${col.value || '(none)'}` : memberOwn ? `▾ ${span.value || '(none)'}` : (span.value || '(none)')}
                  </div>
                )}
              </th>
            );
          })}

          {/* Access-package bands (labels live on the pinned names row) + the
              right metadata placeholders (#, Type, Description). */}
          <MatrixHeaderRowTail accessPackages={accessPackages} />
        </tr>
      ))}

      {/* Final row: User names — the only sticky header row on vertical scroll */}
      <tr>
        {/* Corner cells for row info headers */}
        <th className="sticky left-0 top-0 z-40 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-1 py-1 text-[10px] text-gray-600 dark:text-gray-400"
            style={{ minWidth: '24px' }}>
        </th>
        <th className="sticky top-0 z-40 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 text-left font-medium"
            style={{ left: '24px', minWidth: '275px' }}>
          Resource Name
        </th>
        <th className="sticky top-0 z-40 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-left font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
            style={{ left: '299px', minWidth: '180px' }}
            title="Contexts this resource belongs to — group category, tags, clusters. Filter by context in the matrix filter.">
          Contexts
        </th>

        {users.map(user => {
          // Collapsed aggregate column: the name row shows the user COUNT and an
          // expand control, instead of a single subject name.
          if (user.isAggregateCol) {
            // The folded count column. The vertical attribute header above DRILLS
            // to the next level; here in the name row two small controls instead
            // EXPLODE this column into its individual member columns at this level
            // — ▾ = all (direct + indirect), ↳ = direct members only.
            return (
              <th key={user.id}
                className="sticky top-0 z-20 border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center bg-indigo-50 dark:bg-indigo-900/20"
                style={{ height: '100px', width: '24px', minWidth: '24px', verticalAlign: 'bottom' }}
                title={`${user.userCount} ${user.userCount === 1 ? 'user' : 'users'} in ${user.value || '(none)'}`}>
                <div className="flex flex-col items-center justify-end h-full pb-1 gap-0.5">
                  <span className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">{user.userCount}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleMembers?.(user.sortKeys, user.level, 'all'); }}
                    className="w-4 h-4 flex items-center justify-center text-[10px] leading-none text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
                    title="Show all members here (direct + indirect)"
                  >▾</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleMembers?.(user.sortKeys, user.level, 'direct'); }}
                    className="w-4 h-4 flex items-center justify-center text-[10px] leading-none text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
                    title="Show direct members at this level only"
                  >↳</button>
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
              className={`sticky top-0 z-20 border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center ${
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

        {/* Access Package labels — on the pinned names row so they stay visible. */}
        {accessPackages.map((ap, idx) => {
          return (
            <th
              key={ap.id}
              className={`sticky top-0 z-20 border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center ${apBandBorderClass(accessPackages, idx)}`}
              style={{ backgroundColor: getAccessPackageColor(idx, isDark), width: '24px', minWidth: '24px', height: '100px', verticalAlign: 'bottom' }}
              title={`${ap.displayName}\nCatalog: ${ap.catalogName || ''}${ap.categoryName ? '\nCategory: ' + ap.categoryName : ''}`}
            >
              <div
                className="text-[10px] text-gray-700 dark:text-gray-200 font-medium select-none cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)', maxHeight: '95px', overflow: 'hidden', whiteSpace: 'nowrap', margin: '0 auto' }}
                onClick={() => onOpenDetail?.('access-package', ap.id, ap.displayName)}
              >
                {ap.displayName}
              </div>
            </th>
          );
        })}

        {/* Right metadata column headers row 2 — # | Type | Description */}
        <th className="sticky top-0 z-20 border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-1 py-1 text-[10px] text-gray-600 dark:text-gray-400 font-medium cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 select-none"
            onClick={onSortByCount}
            title="Sort by member count (descending)">
          <div style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}># &#x25BC;</div>
        </th>
        <th className="sticky top-0 z-20 border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 font-medium text-left"
            style={{ minWidth: '180px' }}>
          Type
        </th>
        <th className="sticky top-0 z-20 border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 font-medium text-left"
            style={{ minWidth: '500px' }}>
          Description
        </th>
      </tr>
    </thead>
  );
}
