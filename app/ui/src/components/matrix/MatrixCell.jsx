import { memo } from 'react';
import { MembershipBadge } from './MatrixBadges';
import CellMarkerStrip from './CellMarkerStrip';
import { CELL_BOX_STYLE } from './cellMarkers';
import { describeCell } from './MatrixCell.helpers';

function MatrixCell({
  cellKey, membershipTypes, managed, apColor, apCount, apNames,
  provisioningGap, gapExpected, overGrant = null,
  extraAccessCount = 0, missingAccessCount = 0,
  heldOutsideCount = 0, heldOutsideNames = null, heldOutsideHoldsRole = false,
  onExplainInherited,
}) {
  const hasMembership = membershipTypes && membershipTypes.size > 0;
  const single = hasMembership && membershipTypes.size === 1;
  const { title, bgColor } = describeCell({
    hasMembership, membershipTypes, managed, apColor, apNames, provisioningGap, gapExpected,
    overGrant, extraAccessCount, missingAccessCount, heldOutsideCount, heldOutsideNames,
    heldOutsideHoldsRole,
  });

  return (
    <td
      className="text-center border-r border-b border-gray-100 dark:border-gray-700"
      // The marker strip owns the top of every cell, so a marker is never
      // painted outside its own box and can never land on a neighbour's badge.
      style={{ ...CELL_BOX_STYLE, backgroundColor: bgColor }}
      title={title}
    >
      {hasMembership && (
        <>
          {[...membershipTypes].map(type => (
            <MembershipBadge
              key={type}
              type={type}
              single={single}
              cellKey={cellKey}
              onExplainInherited={onExplainInherited}
            />
          ))}
        </>
      )}
      <CellMarkerStrip
        provisioningGap={provisioningGap}
        overGrant={overGrant}
        apCount={apCount}
        extraAccessCount={extraAccessCount}
        missingAccessCount={missingAccessCount}
        heldOutsideCount={heldOutsideCount}
        heldOutsideNames={heldOutsideNames}
        heldOutsideHoldsRole={heldOutsideHoldsRole}
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
    prev.heldOutsideCount === next.heldOutsideCount &&
    prev.heldOutsideNames === next.heldOutsideNames &&
    prev.heldOutsideHoldsRole === next.heldOutsideHoldsRole &&
    prev.onExplainInherited === next.onExplainInherited
  );
});
