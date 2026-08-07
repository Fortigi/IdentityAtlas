import MatrixCell from './MatrixCell';
import CellMarkerStrip from './CellMarkerStrip';
import MatrixContextsCell from './MatrixContextsCell';
import { CELL_BOX_STYLE } from './cellMarkers';
import {
  cellDeviation, heldOutsideRole, holdsBusinessRole, NO_DEVIATION, NO_HELD_OUTSIDE,
} from './coverageDeviation';
import { getAccessPackageColor } from '@ui/utils/colors';
import { getApRoleBadge } from '@ui/utils/accessPackageStyles';
import { useIsDark } from '@ui/contexts/ThemeContext';

// Fold affordance state for this row, or null when the row is not a foldable
// business role (only roles that are present in the grid AND grant at least one
// visible resource get one — see useBusinessRoleFold).
function roleFoldState({ group, foldableRoles, foldedRoles, roleFoldInfo }) {
  const roleKey = String(group.realGroupId || group.id || '').toUpperCase();
  if (group.isNestedRow || !foldableRoles?.has(roleKey)) return null;
  return {
    roleKey,
    folded: !!foldedRoles?.has(roleKey),
    total: roleFoldInfo?.get(roleKey)?.total || 0,
  };
}

// The one expand/collapse affordance of the grid — used both by the nested-group
// expand and by the business-role fold, so a row that opens into sub-rows always
// looks and behaves the same wherever those sub-rows come from.
function RowExpandToggle({ expanded, loading, onClick, label }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-gray-600 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
      aria-label={label}
      title={label}
    >
      {loading ? (
        <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <span className="text-[10px] leading-none">{expanded ? '▼' : '▶'}</span>
      )}
    </button>
  );
}

// Folds a business role's resources away (and back). Renders nothing for rows
// that aren't foldable business roles.
function RoleFoldToggle({ fold, onToggle }) {
  if (!fold) return null;
  return (
    <RowExpandToggle
      expanded={!fold.folded}
      onClick={() => onToggle?.(fold.roleKey)}
      label={fold.folded ? 'Unfold business role resources' : 'Fold business role resources'}
    />
  );
}

// The OTHER business roles that grant this resource — the ones whose copy of the
// row the reader is not currently looking at. A resource now has a row under
// every role that grants it, so this chip is what says "and it is in N more":
// it turns a row that looks unremarkable into a visible catalogue overlap, and
// clicking it opens the other role.
//
// The chip is a marker, not a name: "BR" for one other role, "BR+3" for three.
// Role names are long and the resource-name column is the one place in the grid
// that has to stay readable, so the names live in the tooltip (and behind the
// click) instead of on the row — requestor feedback on #370.
function RoleOwnerChip({ owners, onOpenDetail }) {
  if (!owners?.length) return null;
  const [first] = owners;
  const label = owners.length > 1 ? `BR+${owners.length}` : 'BR';
  const title = `Also granted by business role: ${owners.map(o => o.name).join(', ')}`;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpenDetail?.('resource', first.id, first.name); }}
      title={title}
      aria-label={title}
      className="flex-shrink-0 ml-1 px-1 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700 dark:hover:bg-indigo-900/50"
    >
      {label}
    </button>
  );
}

// "N resources folded" chip on a collapsed business role row. The row's own
// cells are untouched — folding hides rows, it never rolls access up. Every
// resource a role grants has a row of its own under that role, so a fold always
// takes away exactly what the role grants: no shared row can be left behind.
function RoleFoldChip({ fold }) {
  if (!fold?.folded || fold.total === 0) return null;
  const { total } = fold;
  return (
    <span className="flex-shrink-0 ml-1 px-1 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
      {`${total} resource${total === 1 ? '' : 's'} folded`}
    </span>
  );
}

// The name cell's tooltip. A resource row states every business role that grants
// it, not just the one whose block this copy of the row sits in — so one hover
// answers "where else does this appear?" without hunting for the other rows.
function rowTitle(group) {
  return group.roleGrantedBy
    ? `${group.displayName}\nGranted by business role: ${group.roleGrantedBy}`
    : group.displayName;
}

// Sticky columns paint their own background, so it has to match the row's.
function stickyBg(group) {
  return group.isNestedRow ? 'bg-gray-50/60 dark:bg-gray-700/40' : 'bg-white dark:bg-gray-800';
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
  onOpenDetail,
  onExplainInherited,
  // Nested group expansion props
  groupsWithNested,
  expandedGroups,
  onToggleExpand,
  loadingNested,
  // Business-role fold props
  foldableRoles,
  foldedRoles,
  roleFoldInfo,
  roleExtraCounts,
  roleMissingCounts,
  onToggleRoleFold,
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

  // Business-role fold (never clashes with the nested-expand chevron above: a
  // business role is not a principal, so it is never in groupsWithNested).
  const roleFold = roleFoldState({ group, foldableRoles, foldedRoles, roleFoldInfo });

  // What the rows this folded role hides say per column: how much access it does
  // NOT grant (more than the role assigns) and how much it assigns that the
  // subject does not have (fewer). Both can be non-zero for the same subject.
  const extraAccessFor = (userId) =>
    (roleFold?.folded && roleExtraCounts?.get(`${roleFold.roleKey}|${userId}`)) || 0;
  const missingAccessFor = (userId) =>
    (roleFold?.folded && roleMissingCounts?.get(`${roleFold.roleKey}|${userId}`)) || 0;

  // A resource is drawn beneath each business role that grants it, as that
  // role's child — same indent + elbow as an expanded nested group. Those rows
  // belong to the role's block and move with it, so they carry no drag handle of
  // their own (the same rule nested sub-rows follow).
  const isRoleChild = !!group.roleParentId;
  const indentLevel = (group.nestLevel || 0) + (isRoleChild ? 1 : 0);
  const isDraggable = !group.isNestedRow && !isRoleChild;

  const nestedBg = stickyBg(group);

  return (
    <tr ref={sortableRef} style={sortableStyle || {}} className={`hover:bg-gray-50/30 dark:hover:bg-gray-700/30 ${group.isNestedRow ? 'bg-gray-50/40 dark:bg-gray-700/30' : ''}`}>
      {/* Drag handle */}
      <td
        className={`sticky left-0 z-10 ${nestedBg} border-r border-b border-gray-200 dark:border-gray-700 px-1 py-0 text-center ${isDraggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{ minWidth: '24px' }}
        {...(isDraggable ? (sortableAttributes || {}) : {})}
        {...(isDraggable ? (sortableListeners || {}) : {})}
      >
        {isDraggable && (
          <span className="text-gray-500 dark:text-gray-600 text-xs select-none">&#x2630;</span>
        )}
      </td>

      {/* Resource Name column - sticky left */}
      <td
        className={`sticky ${nestedBg} border-r border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-900 dark:text-gray-100 font-medium`}
        style={{ left: '24px', minWidth: '275px', maxWidth: '275px', zIndex: 10 }}
        title={rowTitle(group)}
      >
        <div className="flex items-center gap-0.5" style={{ paddingLeft: indentLevel * 16 }}>
          <RoleFoldToggle fold={roleFold} onToggle={onToggleRoleFold} />
          {canExpand && (
            <RowExpandToggle
              expanded={isExpanded}
              loading={isLoadingNested}
              onClick={() => onToggleExpand?.(realGidForExpand)}
              label={isExpanded ? 'Collapse nested groups' : 'Expand nested groups'}
            />
          )}
          {(group.isNestedRow || isRoleChild) && (
            <span className="text-gray-500 dark:text-gray-600 text-[10px] mr-0.5 flex-shrink-0">{'\u2514'}</span>
          )}
          <div className="truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
            onClick={() => onOpenDetail?.('resource', group.realGroupId || group.id, group.displayName)}>
            {group.displayName}
          </div>
          <RoleOwnerChip owners={group.roleOwners} onOpenDetail={onOpenDetail} />
          <RoleFoldChip fold={roleFold} />
        </div>
      </td>

      {/* Contexts column - sticky left */}
      <MatrixContextsCell
        contexts={group.contexts}
        className={`sticky border-r ${nestedBg}`}
        style={{ left: '299px', minWidth: '180px', maxWidth: '180px', zIndex: 10 }}
      />

      {/* Intersection cells */}
      {users.map(user => {
        // Collapsed (folded) attribute group → show the count of Direct
        // assignments among its users instead of per-subject badges.
        if (user.isAggregateCol) {
          const n = aggDirectCounts?.get(`${group.id} ${user.id}`) || 0;
          const extra = extraAccessFor(user.id);
          const short = missingAccessFor(user.id);
          return (
            <td key={user.id}
              className="border-r border-b border-gray-200 dark:border-gray-700 text-center bg-indigo-50/40 dark:bg-indigo-900/10"
              style={CELL_BOX_STYLE}>
              {n > 0
                ? <span className="text-[10px] font-semibold text-gray-800 dark:text-gray-200">{n}</span>
                : <span className="text-gray-500 dark:text-gray-700">·</span>}
              <CellMarkerStrip extraAccessCount={extra} missingAccessCount={short} />
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

        // How this cell deviates from what the business roles covering it assign:
        // `missing` = fewer than they assign (the provisioning gap), `excess` =
        // more (a standing membership where the role only grants eligibility).
        // Both sides read off server-computed coverage — see coverageDeviation.js.
        const deviation = managed
          ? cellDeviation({ types: cellTypes, apIds: relevantApIds, apGroupMap, resourceKey: realGid.toUpperCase() })
          : NO_DEVIATION;

        // The subject holds a resource the business role(s) on this row hand
        // out, and none of those roles carries an assignment of it for them —
        // what a folded role reports as its red count, said here on the
        // resource's own row so the two views agree. `holdsRole` reads the
        // parent role's own assignments off the coverage view, so the marker
        // says which of the two findings it actually established. Suppressed in
        // the non-governed view along with every other business-role indicator.
        const heldOutside = managedFilter === 'unmanaged' ? NO_HELD_OUTSIDE : heldOutsideRole({
          types: cellTypes,
          roleGrantIds: group.roleGrantIds,
          apIds: relevantApIds,
          holdsRole: roleId => holdsBusinessRole(managedApMap, roleId, user.id),
        });

        return (
          <MatrixCell
            key={cellKey}
            cellKey={cellKey}
            membershipTypes={cellTypes}
            managed={managed}
            apColor={apColor}
            apCount={apCount}
            apNames={apNames}
            provisioningGap={deviation.missing.length > 0}
            gapExpected={deviation.missing[0] || null}
            overGrant={deviation.excess[0] || null}
            extraAccessCount={extraAccessFor(user.id)}
            missingAccessCount={missingAccessFor(user.id)}
            heldOutsideCount={heldOutside.count}
            heldOutsideNames={group.roleGrantedBy}
            heldOutsideHoldsRole={heldOutside.holdsGrantingRole}
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
              const badge = getApRoleBadge(roleName);
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

      {/* Right-side metadata: # | Type | Description */}
      <td className="border-l-2 border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400 text-center"
          style={{ minWidth: '40px' }}>
        {memberCount}
      </td>
      <td className="border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400 truncate"
          style={{ minWidth: '180px', maxWidth: '180px' }}
          title={group.groupType}>
        {group.groupType}
      </td>
      <td className="border-b border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-500 max-w-[500px]"
          title={group.description}>
        <div className="truncate">{group.description}</div>
      </td>
    </tr>
  );
}
