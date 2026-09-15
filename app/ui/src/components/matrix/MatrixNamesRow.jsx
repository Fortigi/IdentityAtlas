import MatrixAggregateNameCell from './MatrixAggregateNameCell';
import MatrixSubjectNameCell from './MatrixSubjectNameCell';
import MatrixApLabelCell from './MatrixApLabelCell';

// The names header row: one cell per subject column. It is the first row that
// stays pinned on vertical scroll — the attribute grouping rows above it scroll
// away.
//
// While at least one identity is expanded, an accounts row follows underneath
// (`hasAccountsRow`): each expanded identity's cell spans its account columns,
// and every other cell spans both rows so no blank band appears beside them.
export default function MatrixNamesRow({
  columns, accountsByParent, hasAccountsRow,
  accessPackages, isDark, onSortByCount, onOpenDetail,
  expandedIdentities, onToggleIdentity, loadingIdentityCols, onToggleMembers, corner = null,
}) {
  const rowSpan = hasAccountsRow ? 2 : undefined;
  return (
    <tr>
      {/* Corner cells for row info headers */}
      <th rowSpan={rowSpan}
          className="sticky left-0 top-0 z-40 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-1 py-1 text-[10px] text-gray-600 dark:text-gray-400"
          style={{ minWidth: '24px' }}>
      </th>
      <th rowSpan={rowSpan}
          className="sticky top-0 z-40 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 text-left font-medium"
          style={{ left: '24px', minWidth: '275px' }}>
        <div className="flex items-center justify-between gap-2">
          <span>Resource Name</span>
          {corner}
        </div>
      </th>
      <th rowSpan={rowSpan}
          className="sticky top-0 z-40 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-left font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
          style={{ left: '299px', minWidth: '180px' }}
          title="Contexts this resource belongs to — group category, tags, clusters. Filter by context in the matrix filter.">
        Contexts
      </th>

      {columns.map((user) => {
        if (user.isAggregateCol) {
          return <MatrixAggregateNameCell key={user.id} user={user} rowSpan={rowSpan} onToggleMembers={onToggleMembers} />;
        }
        // An expanded identity spans one column per linked account, and the
        // accounts row below fills that span. Every other subject spans the
        // accounts row instead.
        const accounts = accountsByParent.get(user.id)?.length || 0;
        return (
          <MatrixSubjectNameCell
            key={user.id}
            user={user}
            colSpan={accounts || undefined}
            rowSpan={accounts ? undefined : rowSpan}
            expandedIdentities={expandedIdentities}
            onToggleIdentity={onToggleIdentity}
            loadingIdentityCols={loadingIdentityCols}
            onOpenDetail={onOpenDetail}
          />
        );
      })}

      {/* Access Package labels — on the pinned names row so they stay visible. */}
      {accessPackages.map((ap, idx) => (
        <MatrixApLabelCell key={ap.id} accessPackages={accessPackages} idx={idx} isDark={isDark} rowSpan={rowSpan} onOpenDetail={onOpenDetail} />
      ))}

      {/* Right metadata column headers row 2 — # | Type | Description */}
      <th rowSpan={rowSpan}
          className="sticky top-0 z-20 border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-1 py-1 text-[10px] text-gray-600 dark:text-gray-400 font-medium cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 select-none"
          onClick={onSortByCount}
          title="Sort by member count (descending)">
        <div style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}># &#x25BC;</div>
      </th>
      <th rowSpan={rowSpan}
          className="sticky top-0 z-20 border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 font-medium text-left"
          style={{ minWidth: '180px' }}>
        Type
      </th>
      <th rowSpan={rowSpan}
          className="sticky top-0 z-20 border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 font-medium text-left"
          style={{ minWidth: '500px' }}>
        Description
      </th>
    </tr>
  );
}
