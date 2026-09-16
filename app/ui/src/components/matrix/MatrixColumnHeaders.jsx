import { useIsDark } from '@ui/contexts/ThemeContext';
import { computeAttributeSpans } from './sortUsers';
import { GROUP_ROW_H, splitAccountColumns } from './MatrixColumnHeaders.helpers';
import { buildCrossRows, computeHeaderMode, crossGroupingHeight } from './headerMode';
import MatrixGroupingRow from './MatrixGroupingRow';
import MatrixCrossTableRows from './MatrixCrossTableRows';
import MatrixNamesRow from './MatrixNamesRow';
import MatrixAccountsRow from './MatrixAccountsRow';

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
  columnCorner = null,
  rowCorner = null,
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

  // An expanded identity's account columns move into an accounts row underneath
  // the names row, where the identity itself is drawn as the cell spanning them
  // — it reads as the parent of its accounts instead of as their left-hand
  // sibling. The grouping rows above keep spanning every column, account columns
  // included: they inherit their parent's sort keys, so the merged spans stay
  // contiguous either way.
  const { namesCols, accountsByParent, hasAccountsRow } = splitAccountColumns(users);

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
  const groupingOffset = crossLevels
    ? crossGroupingHeight(crossLevels, { withCorner: !!columnCorner })
    : attrRows.length * GROUP_ROW_H;
  return (
    <thead className="sticky z-30" style={{ top: `-${groupingOffset}px` }}>
      {crossLevels ? (
        <MatrixCrossTableRows
          levels={crossLevels}
          users={users}
          infoColumnCount={infoColumnCount}
          accessPackages={accessPackages}
          isDark={isDark}
          onToggleCollapse={onToggleCollapse}
          onToggleMembers={onToggleMembers}
          corner={columnCorner}
        />
      ) : null}

      {/* Rotated fallback: one merged row per sort attribute */}
      {rotatedRows.map((row, rowIdx) => (
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
          corner={rowIdx === 0 ? columnCorner : null}
        />
      ))}

      {/* User names — the first sticky header row on vertical scroll */}
      <MatrixNamesRow
        columns={namesCols}
        accountsByParent={accountsByParent}
        hasAccountsRow={hasAccountsRow}
        accessPackages={accessPackages}
        isDark={isDark}
        onSortByCount={onSortByCount}
        onOpenDetail={onOpenDetail}
        expandedIdentities={expandedIdentities}
        onToggleIdentity={onToggleIdentity}
        loadingIdentityCols={loadingIdentityCols}
        onToggleMembers={onToggleMembers}
        corner={rowCorner}
      />

      {/* The accounts of every expanded identity, under their identity. It sits
          after the names row, so the sticky <thead> pins it along with it — the
          grouping offset above must NOT grow to account for it. */}
      {hasAccountsRow && (
        <MatrixAccountsRow
          columns={namesCols}
          accountsByParent={accountsByParent}
          onOpenDetail={onOpenDetail}
        />
      )}
    </thead>
  );
}
