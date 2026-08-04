import { memo } from 'react';
import { TYPE_COLORS } from '@ui/utils/colors';
import CellBadges from './CellBadges';
import { extraAccessTitle, missingAccessTitle, overGrantTitle } from './cellMarkers';

// Everything the cell says on hover: how the access is held, which business
// roles govern it, and any marker it carries. Pulled out of the component so
// the wording lives in one readable place.
function cellTitle({ membershipTypes, managed, apNames, provisioningGap, gapExpected, overGrant, extraAccessCount, missingAccessCount }) {
  const parts = [];
  const managedBy = apNames?.length ? `Managed by: ${apNames.join(', ')}` : null;
  if (membershipTypes?.size) {
    const types = [...membershipTypes].join(', ');
    parts.push(managedBy ? `${types}\n${managedBy}` : (managed ? `${types} (managed by business role)` : types));
  } else if (provisioningGap) {
    // A business role manages this cell but the subject has no membership at all.
    const expected = gapExpected ? ` ${gapExpected}` : '';
    parts.push(`⚠ Provisioning gap: business role expects${expected} membership but user has none`);
    if (managedBy) parts.push(managedBy);
  }
  if (overGrant) parts.push(overGrantTitle(overGrant));
  if (extraAccessCount > 0) parts.push(extraAccessTitle(extraAccessCount));
  if (missingAccessCount > 0) parts.push(missingAccessTitle(missingAccessCount));
  return parts.length ? parts.join('\n') : undefined;
}

function MembershipBadges({ membershipTypes, cellKey, onExplainInherited }) {
  return [...membershipTypes].map(type => {
    const ind = TYPE_COLORS[type];
    if (!ind) return <span key={type} className="text-[7px] font-bold text-green-800">?</span>;
    const clickable = type === 'Indirect' && !!onExplainInherited;
    return (
      <span
        key={type}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? (e) => { e.stopPropagation(); onExplainInherited(cellKey); } : undefined}
        title={clickable ? 'Show how this inherited access was derived' : undefined}
        className={`inline-block rounded-sm text-center font-bold ${membershipTypes.size === 1 ? 'w-4 h-4 text-[9px] leading-4' : 'w-[9px] h-[14px] text-[7px] leading-[14px]'} ${clickable ? 'cursor-pointer ring-1 ring-white/50 hover:ring-2 hover:ring-white' : ''}`}
        style={{ backgroundColor: ind.bg, color: ind.text }}
      >
        {ind.letter}
      </span>
    );
  });
}

function MatrixCell({
  cellKey, membershipTypes, managed, apColor, apCount, apNames,
  provisioningGap, gapExpected, overGrant = null,
  extraAccessCount = 0, missingAccessCount = 0, onExplainInherited,
}) {
  const hasMembership = membershipTypes && membershipTypes.size > 0;

  // Background: the business role's colour on a governed cell — and on a
  // provisioning gap, which is governance without the membership. An ungoverned
  // cell stays white.
  const bgColor = (hasMembership ? managed : provisioningGap) ? (apColor || '#dbeafe') : undefined;

  const title = cellTitle({
    membershipTypes, managed, apNames, provisioningGap, gapExpected,
    overGrant, extraAccessCount, missingAccessCount,
  });

  const needsRelative = apCount > 1 || provisioningGap || !!overGrant
    || extraAccessCount > 0 || missingAccessCount > 0;

  return (
    <td
      className="px-0 py-0 text-center border-r border-b border-gray-100 dark:border-gray-700"
      style={{
        backgroundColor: bgColor,
        minWidth: '24px',
        width: '24px',
        height: '24px',
        position: needsRelative ? 'relative' : undefined,
        zIndex: needsRelative ? 1 : undefined,
      }}
      title={title}
    >
      {hasMembership && (
        <MembershipBadges
          membershipTypes={membershipTypes}
          cellKey={cellKey}
          onExplainInherited={onExplainInherited}
        />
      )}
      <CellBadges
        provisioningGap={provisioningGap}
        overGrant={overGrant}
        apCount={apCount}
        extraAccessCount={extraAccessCount}
        missingAccessCount={missingAccessCount}
      />
    </td>
  );
}

export default memo(MatrixCell, (prev, next) => {
  return (
    prev.membershipTypes === next.membershipTypes &&
    prev.managed === next.managed &&
    prev.apColor === next.apColor &&
    prev.apCount === next.apCount &&
    prev.apNames === next.apNames &&
    prev.provisioningGap === next.provisioningGap &&
    prev.gapExpected === next.gapExpected &&
    prev.overGrant === next.overGrant &&
    prev.extraAccessCount === next.extraAccessCount &&
    prev.missingAccessCount === next.missingAccessCount &&
    prev.onExplainInherited === next.onExplainInherited
  );
});
