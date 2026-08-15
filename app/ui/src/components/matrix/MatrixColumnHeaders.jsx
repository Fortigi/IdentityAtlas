import { useIsDark } from '@ui/contexts/ThemeContext';
import { computeAttributeSpans } from './sortUsers';
import { GROUP_ROW_H } from './MatrixColumnHeaders.helpers';
import MatrixGroupingRow from './MatrixGroupingRow';
import MatrixNamesRow from './MatrixNamesRow';

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
}) {
  const isDark = useIsDark();

  // One merged header row per sort attribute (default: department), each
  // grouping consecutive columns that share the same value (read from each
  // user's precomputed sortKeys[index]). In hierarchy sort, maxHeaderDepth caps
  // the rows to the unfolded depth so the next org level only appears once a
  // group is expanded into it.
  const attrs = (Array.isArray(sortAttributes) && sortAttributes.length)
    ? sortAttributes.map(s => s.attribute)
    : ['department'];
  const shown = (typeof maxHeaderDepth === 'number' && maxHeaderDepth > 0)
    ? Math.min(maxHeaderDepth, attrs.length) : attrs.length;
  const attrRows = attrs.slice(0, shown).map((attribute, index) => ({ attribute, spans: computeAttributeSpans(users, index) }));

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
  const groupingOffset = attrRows.length * GROUP_ROW_H;
  return (
    <thead className="sticky z-30" style={{ top: `-${groupingOffset}px` }}>
      {/* One merged row per sort attribute */}
      {attrRows.map((row, rowIdx) => (
        <MatrixGroupingRow
          key={row.attribute + rowIdx}
          row={row}
          rowIdx={rowIdx}
          infoColumnCount={infoColumnCount}
          users={users}
          accessPackages={accessPackages}
          isDark={isDark}
          onToggleCollapse={onToggleCollapse}
          onToggleMembers={onToggleMembers}
        />
      ))}

      {/* Final row: User names — the only sticky header row on vertical scroll */}
      <MatrixNamesRow
        users={users}
        accessPackages={accessPackages}
        isDark={isDark}
        onSortByCount={onSortByCount}
        onOpenDetail={onOpenDetail}
        expandedIdentities={expandedIdentities}
        onToggleIdentity={onToggleIdentity}
        loadingIdentityCols={loadingIdentityCols}
        onToggleMembers={onToggleMembers}
      />
    </thead>
  );
}
