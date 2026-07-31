import MatrixCell from './MatrixCell';
import MatrixContextsCell from './MatrixContextsCell';
import { getAccessPackageColor } from '@ui/utils/colors';
import { contextsForGroup } from '@ui/utils/matrixContexts';
import { useIsDark } from '@ui/contexts/ThemeContext';

// Map AP resource role names to the same badge style used in user/group cells.
// Group ownership is its own resource (resourceType='GroupOwnership') now, so
// access-package role scopes only ever resolve to Member (Direct) or Eligible.
const BADGE_DIRECT   = { letter: 'D', bg: '#166534', text: '#fff' };
const BADGE_ELIGIBLE = { letter: 'E', bg: '#854d0e', text: '#fff' };

function getRoleBadge(roleName) {
  const lower = (roleName || '').toLowerCase();
  if (lower.includes('eligible')) return BADGE_ELIGIBLE;
  return BADGE_DIRECT;
}

export default function MatrixGroupRow({
  group,
  users,
  totalUsers,
  memberships,
  aggDirectCounts,
  managedMap,
  managedApMap,
  apIdToIndex,
  accessPackages = [],
  apGroupMap,
  managedFilter,
  resourceContextsMap,
  onOpenDetail,
  onExplainInherited,
  // Nested group expansion props
  groupsWithNested,
  expandedGroups,
  onToggleExpand,
  loadingNested,
  // Optional DnD props (provided by SortableRow wrapper)
  sortableRef,
  sortableStyle,
  sortableAttributes,
  sortableListeners,
}) {
  const isDark = useIsDark();
  const memberCount = group.memberCount;

  // Expand/collapse state for nested groups (up to 4 levels deep)
  const realGidForExpand = group.realGroupId || group.id;
  const canExpand = (group.nestLevel || 0) < 4 && groupsWithNested?.has(realGidForExpand);
  const isExpanded = expandedGroups?.has(realGidForExpand);
  const isLoadingNested = loadingNested?.has(realGidForExpand);

  const nestedBg = group.isNestedRow ? 'bg-gray-50/60 dark:bg-gray-700/40' : 'bg-white dark:bg-gray-800';

  return (
    <tr ref={sortableRef} style={sortableStyle || {}} className={`hover:bg-gray-50/30 dark:hover:bg-gray-700/30 ${group.isNestedRow ? 'bg-gray-50/40 dark:bg-gray-700/30' : ''}`}>
      {/* Drag handle */}
      <td
        className={`sticky left-0 z-10 ${nestedBg} border-r border-b border-gray-200 dark:border-gray-700 px-1 py-0 text-center ${!group.isNestedRow ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{ minWidth: '24px' }}
        {...(group.isNestedRow ? {} : (sortableAttributes || {}))}
        {...(group.isNestedRow ? {} : (sortableListeners || {}))}
      >
        {!group.isNestedRow && (
          <span className="text-gray-500 dark:text-gray-600 text-xs select-none">&#x2630;</span>
        )}
      </td>

      {/* Resource Name column - sticky left */}
      <td
        className={`sticky ${nestedBg} border-r border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-900 dark:text-gray-100 font-medium`}
        style={{ left: '24px', minWidth: '275px', maxWidth: '275px', zIndex: 10 }}
        title={group.displayName}
      >
        <div className="flex items-center gap-0.5" style={{ paddingLeft: (group.nestLevel || 0) * 16 }}>
          {canExpand && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleExpand?.(realGidForExpand); }}
              className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-gray-600 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
              title={isExpanded ? 'Collapse nested groups' : 'Expand nested groups'}
            >
              {isLoadingNested ? (
                <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <span className="text-[10px] leading-none">{isExpanded ? '\u25BC' : '\u25B6'}</span>
              )}
            </button>
          )}
          {group.isNestedRow && (
            <span className="text-gray-500 dark:text-gray-600 text-[10px] mr-0.5 flex-shrink-0">{'\u2514'}</span>
          )}
          <div className="truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
            onClick={() => onOpenDetail?.('resource', group.realGroupId || group.id, group.displayName)}>
            {group.displayName}
          </div>
        </div>
      </td>

      {/* Type column - sticky left */}
      <td
        className={`sticky ${nestedBg} border-r border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400 truncate`}
        style={{ left: '299px', minWidth: '180px', maxWidth: '180px', zIndex: 10 }}
        title={group.groupType}
      >
        {group.groupType}
      </td>

      {/* Intersection cells */}
      {users.map(user => {
        // Collapsed (folded) attribute group → show the count of Direct
        // assignments among its users instead of per-subject badges.
        if (user.isAggregateCol) {
          const n = aggDirectCounts?.get(`${group.id} ${user.id}`) || 0;
          return (
            <td key={user.id}
              className="border-r border-b border-gray-200 dark:border-gray-700 text-center px-0 py-0 bg-indigo-50/40 dark:bg-indigo-900/10"
              style={{ width: '24px', minWidth: '24px' }}>
              {n > 0
                ? <span className="text-[10px] font-semibold text-gray-800 dark:text-gray-200">{n}</span>
                : <span className="text-gray-500 dark:text-gray-700">·</span>}
            </td>
          );
        }
        const cellKey = `${group.id}|${user.id}`;
        const cellTypes = memberships.get(cellKey);

        // AP management overlay — which package(s) govern this cell (drives the
        // colour + count + tooltip). Keyed by the real group id.
        const realGid = group.realGroupId || group.id;
        const cellKeyLower = `${realGid.toLowerCase()}|${user.id.toLowerCase()}`;
        const relevantApIds = managedApMap?.get(cellKeyLower) || [];

        // In "unmanaged" filter mode, suppress AP management indicators — user is focused on ungoverned access
        const managed = managedFilter !== 'unmanaged' && relevantApIds.length > 0;
        let apColor = null;
        let apCount = 0;
        let apNames = null;

        if (managed) {
          apCount = relevantApIds.length;
          const firstIdx = apIdToIndex?.get(relevantApIds[0]);
          if (firstIdx != null) apColor = getAccessPackageColor(firstIdx, isDark);
          apNames = relevantApIds.map(id => {
            const ap = accessPackages.find(a => a.id.toLowerCase() === id);
            return ap ? ap.displayName : id;
          });
        }

        // Provisioning gap: the cell is governance-managed (an access package the
        // subject holds Contains this resource — server-computed managedByAccessPackage)
        // but the subject has no actual membership. The SOLL coverage is derived in
        // the data; the gap is just "managed and empty".
        const hasActual = cellTypes && cellTypes.size > 0;
        const provisioningGap = managed && !hasActual;
        const gapExpected = provisioningGap ? 'Direct' : null;

        return (
          <MatrixCell
            key={cellKey}
            cellKey={cellKey}
            membershipTypes={cellTypes}
            managed={managed}
            apColor={apColor}
            apCount={apCount}
            apNames={apNames}
            provisioningGap={provisioningGap}
            gapExpected={gapExpected}
            onExplainInherited={onExplainInherited}
          />
        );
      })}

      {/* Access Package cells (SOLL) */}
      {accessPackages.map((ap, idx) => {
        const lookupGid = (group.realGroupId || group.id).toUpperCase();
        const apKey = `${lookupGid}|${ap.id.toLowerCase()}`;
        const roleName = apGroupMap?.get(apKey);
        const hasMapping = !!roleName;
        const prevCat = idx > 0 ? (accessPackages[idx - 1].categoryName || null) : undefined;
        const curCat = ap.categoryName || null;
        const isCategoryBoundary = idx === 0 || prevCat !== curCat;
        return (
          <td
            key={ap.id}
            className={`px-0 py-0 text-center border-r border-b border-gray-100 dark:border-gray-700 ${idx === 0 ? 'border-l-2 border-l-indigo-300 dark:border-l-indigo-500' : isCategoryBoundary ? 'border-l-2 border-l-gray-400 dark:border-l-gray-500' : ''}`}
            style={{
              backgroundColor: hasMapping ? getAccessPackageColor(idx, isDark) : undefined,
              minWidth: '24px',
              width: '24px',
              height: '24px',
            }}
            title={hasMapping ? `${ap.displayName} (${roleName})${ap.categoryName ? ' — Category: ' + ap.categoryName : ''}` : undefined}
          >
            {hasMapping && (() => {
              const badge = getRoleBadge(roleName);
              return (
                <span
                  className="inline-block w-4 h-4 rounded-sm text-center font-bold leading-4 text-[9px]"
                  style={{ backgroundColor: badge.bg, color: badge.text }}
                >
                  {badge.letter}
                </span>
              );
            })()}
          </td>
        );
      })}

      {/* Right-side metadata: # | Description */}
      <td className="border-l-2 border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400 text-center"
          style={{ minWidth: '40px' }}>
        {memberCount}
      </td>
      <td className="border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-500 max-w-[500px]"
          title={group.description}>
        <div className="truncate">{group.description}</div>
      </td>
      <MatrixContextsCell contexts={contextsForGroup(resourceContextsMap, group)} />
    </tr>
  );
}
