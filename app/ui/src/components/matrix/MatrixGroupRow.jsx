import MatrixCell from './MatrixCell';
import { getAccessPackageColor } from './MatrixColumnHeaders';

// Map AP resource role names to the same badge style used in user/group cells.
// roleDisplayName from Graph can be "Member", "Owner", "Eligible Member", etc.
const BADGE_DIRECT   = { letter: 'D', bg: '#166534', text: '#fff' };
const BADGE_OWNER    = { letter: 'O', bg: '#9d174d', text: '#fff' };
const BADGE_ELIGIBLE = { letter: 'E', bg: '#854d0e', text: '#fff' };

function getRoleBadge(roleName) {
  const lower = (roleName || '').toLowerCase();
  if (lower.includes('owner')) return BADGE_OWNER;
  if (lower.includes('eligible')) return BADGE_ELIGIBLE;
  return BADGE_DIRECT;
}

export default function MatrixGroupRow({
  group,
  users,
  totalUsers,
  memberships,
  managedMap,
  managedApMap,
  apIdToIndex,
  accessPackages = [],
  apGroupMap,
  managedFilter,
  onOpenDetail,
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
  const memberCount = group.memberCount;
  const isOwnerRow = !!group.realGroupId && !group.isNestedRow;

  // Expand/collapse state for nested groups (up to 4 levels deep)
  const realGidForExpand = group.realGroupId || group.id;
  const canExpand = (group.nestLevel || 0) < 4 && groupsWithNested?.has(realGidForExpand);
  const isExpanded = expandedGroups?.has(realGidForExpand);
  const isLoadingNested = loadingNested?.has(realGidForExpand);

  const nestedBg = group.isNestedRow ? 'bg-gray-50/60' : 'bg-white';

  return (
    <tr ref={sortableRef} style={sortableStyle || {}} className={`hover:bg-gray-50/30 ${group.isNestedRow ? 'bg-gray-50/40' : ''}`}>
      {/* Drag handle */}
      <td
        className={`sticky left-0 z-10 ${nestedBg} border-r border-b border-gray-200 px-1 py-0 text-center ${!group.isNestedRow ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{ minWidth: '24px' }}
        {...(group.isNestedRow ? {} : (sortableAttributes || {}))}
        {...(group.isNestedRow ? {} : (sortableListeners || {}))}
      >
        {!group.isNestedRow && (
          <span className="text-gray-300 text-xs select-none">&#x2630;</span>
        )}
      </td>

      {/* Resource Name column - sticky left */}
      <td
        className={`sticky ${nestedBg} border-r border-b border-gray-200 px-2 py-0.5 text-xs text-gray-900 font-medium`}
        style={{ left: '24px', minWidth: '275px', maxWidth: '275px', zIndex: 10 }}
        title={group.displayName}
      >
        <div className="flex items-center gap-0.5" style={{ paddingLeft: (group.nestLevel || 0) * 16 }}>
          {canExpand && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleExpand?.(realGidForExpand); }}
              className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded hover:bg-gray-200"
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
            <span className="text-gray-300 text-[10px] mr-0.5 flex-shrink-0">{'\u2514'}</span>
          )}
          <div className="truncate cursor-pointer hover:text-blue-600"
            onClick={() => onOpenDetail?.('resource', group.realGroupId || group.id, group.displayName)}>
            {group.displayName}
          </div>
        </div>
      </td>

      {/* Type column - sticky left */}
      <td
        className={`sticky ${nestedBg} border-r border-b border-gray-200 px-2 py-0.5 text-xs text-gray-500 truncate`}
        style={{ left: '299px', minWidth: '180px', maxWidth: '180px', zIndex: 10 }}
        title={group.groupType}
      >
        {group.groupType}
      </td>

      {/* Intersection cells */}
      {users.map(user => {
        const cellKey = `${group.id}|${user.id}`;
        const cellTypes = memberships.get(cellKey);

        // Look up AP management using the real group ID (not synthetic __owner ID)
        const realGid = group.realGroupId || group.id;
        const cellKeyLower = `${realGid.toLowerCase()}|${user.id.toLowerCase()}`;
        const allApIds = managedApMap?.get(cellKeyLower) || [];
        const lookupGid = realGid.toUpperCase();

        // Filter APs by role relevance for this row type:
        // Owner rows only show APs with Owner role; regular rows show non-Owner APs.
        const relevantApIds = allApIds.filter(apId => {
          const role = apGroupMap?.get(`${lookupGid}|${apId}`) || 'Member';
          const roleIsOwner = role.toLowerCase().includes('owner');
          return isOwnerRow ? roleIsOwner : !roleIsOwner;
        });

        // In "unmanaged" filter mode, suppress AP management indicators — user is focused on ungoverned access
        const managed = managedFilter !== 'unmanaged' && relevantApIds.length > 0;
        let apColor = null;
        let apCount = 0;
        let apNames = null;

        if (managed) {
          apCount = relevantApIds.length;
          const firstIdx = apIdToIndex?.get(relevantApIds[0]);
          if (firstIdx != null) apColor = getAccessPackageColor(firstIdx);
          apNames = relevantApIds.map(id => {
            const ap = accessPackages.find(a => a.id.toLowerCase() === id);
            return ap ? ap.displayName : id;
          });
        }

        // Provisioning gap: AP manages this cell but user lacks the expected membership type.
        // Owner role → needs Owner; Eligible role → needs Eligible; Member/default → needs Direct.
        // Skip gap detection in "unmanaged" filter — gaps are irrelevant when viewing only unmanaged access.
        let provisioningGap = false;
        let gapExpected = null;
        if (managed && managedFilter !== 'unmanaged') {
          for (const apId of relevantApIds) {
            const role = apGroupMap?.get(`${lookupGid}|${apId}`) || 'Member';
            const lower = role.toLowerCase();
            let expected, hasIt;
            if (lower.includes('owner'))        { expected = 'Owner';    hasIt = cellTypes?.has('Owner'); }
            else if (lower.includes('eligible')) { expected = 'Eligible'; hasIt = cellTypes?.has('Eligible'); }
            else                                 { expected = 'Direct';   hasIt = cellTypes?.has('Direct'); }
            if (!hasIt) {
              provisioningGap = true;
              gapExpected = expected;
              break;
            }
          }
        }

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
          />
        );
      })}

      {/* Access Package cells (SOLL) */}
      {accessPackages.map((ap, idx) => {
        // For owner rows, look up using realGroupId (AP data uses real group IDs)
        const lookupGid = (group.realGroupId || group.id).toUpperCase();
        const apKey = `${lookupGid}|${ap.id.toLowerCase()}`;
        const roleName = apGroupMap?.get(apKey);
        // Owner rows only show AP cells where the role is Owner;
        // regular rows only show non-Owner roles
        const isOwnerForAp = !!group.realGroupId && !group.isNestedRow;
        const roleIsOwner = (roleName || '').toLowerCase().includes('owner');
        const hasMapping = !!roleName && (isOwnerForAp ? roleIsOwner : !roleIsOwner);
        const prevCat = idx > 0 ? (accessPackages[idx - 1].categoryName || null) : undefined;
        const curCat = ap.categoryName || null;
        const isCategoryBoundary = idx === 0 || prevCat !== curCat;
        return (
          <td
            key={ap.id}
            className={`px-0 py-0 text-center border-r border-b border-gray-100 ${idx === 0 ? 'border-l-2 border-l-indigo-300' : isCategoryBoundary ? 'border-l-2 border-l-gray-400' : ''}`}
            style={{
              backgroundColor: hasMapping ? getAccessPackageColor(idx) : undefined,
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

      {/* Right-side metadata: # | Description | Tags */}
      <td className="border-l-2 border-b border-gray-200 px-2 py-0.5 text-xs text-gray-600 text-center"
          style={{ minWidth: '40px' }}>
        {memberCount}
      </td>
      <td className="border-b border-gray-200 px-2 py-0.5 text-xs text-gray-400 max-w-[500px]"
          title={group.description}>
        <div className="truncate">{group.description}</div>
      </td>
      <td className="border-b border-gray-200 px-1 py-0.5"
          style={{ minWidth: '120px', maxWidth: '180px' }}>
        <div className="flex flex-wrap gap-0.5">
          {(group.tags || []).map(t => (
            <span
              key={t.id}
              className="inline-block px-1 py-0 rounded-full text-[9px] font-medium border leading-tight"
              style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}
              title={t.name}
            >
              {t.name}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}
