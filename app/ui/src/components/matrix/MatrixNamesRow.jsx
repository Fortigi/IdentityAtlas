import MatrixAggregateNameCell from './MatrixAggregateNameCell';
import MatrixSubjectNameCell from './MatrixSubjectNameCell';
import MatrixApLabelCell from './MatrixApLabelCell';

// The final header row: user names. It is the only row that stays pinned on
// vertical scroll — the attribute grouping rows above it scroll away.
export default function MatrixNamesRow({
  users, accessPackages, isDark, onSortByCount, onOpenDetail,
  expandedIdentities, onToggleIdentity, loadingIdentityCols, onToggleMembers,
}) {
  return (
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

      {users.map(user => user.isAggregateCol ? (
        <MatrixAggregateNameCell key={user.id} user={user} onToggleMembers={onToggleMembers} />
      ) : (
        <MatrixSubjectNameCell
          key={user.id}
          user={user}
          expandedIdentities={expandedIdentities}
          onToggleIdentity={onToggleIdentity}
          loadingIdentityCols={loadingIdentityCols}
          onOpenDetail={onOpenDetail}
        />
      ))}

      {/* Access Package labels — on the pinned names row so they stay visible. */}
      {accessPackages.map((ap, idx) => (
        <MatrixApLabelCell key={ap.id} accessPackages={accessPackages} idx={idx} isDark={isDark} onOpenDetail={onOpenDetail} />
      ))}

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
  );
}
