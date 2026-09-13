import { memo } from 'react';
import { TYPE_COLORS } from '@ui/utils/colors';
import CellMarkerStrip from './CellMarkerStrip';
import { CELL_BOX_STYLE } from './cellMarkers';
import { describeCell } from './MatrixCell.helpers';

// One membership-type swatch (D / I / E). Indirect badges become clickable when
// an explainer handler is supplied, so the analyst can trace inherited access.
function MembershipBadge({ type, single, cellKey, onExplainInherited }) {
  const ind = TYPE_COLORS[type];
  if (!ind) return <span className="text-[7px] font-bold text-green-800">?</span>;

  const clickable = type === 'Indirect' && !!onExplainInherited;
  const sizeClass = single ? 'w-4 h-4 text-[9px] leading-4' : 'w-[9px] h-[14px] text-[7px] leading-[14px]';
  const clickClass = clickable ? 'cursor-pointer ring-1 ring-white/50 hover:ring-2 hover:ring-white' : '';

  return (
    <span
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? (e) => { e.stopPropagation(); onExplainInherited(cellKey); } : undefined}
      title={clickable ? 'Show how this inherited access was derived' : undefined}
      className={`inline-block rounded-sm text-center font-bold ${sizeClass} ${clickClass}`}
      style={{ backgroundColor: ind.bg, color: ind.text }}
    >
      {ind.letter}
    </span>
  );
}

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
