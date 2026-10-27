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
  // Optional, for a screen that selects cells (the Authorization workbench); the
  // matrix passes none of these, so its cells stay exactly as they were.
  onSelect, selected = false, label, children,
}) {
  const hasMembership = membershipTypes && membershipTypes.size > 0;
  const single = hasMembership && membershipTypes.size === 1;
  const { title, bgColor } = describeCell({
    hasMembership, membershipTypes, managed, apColor, apNames, provisioningGap, gapExpected,
    overGrant, extraAccessCount, missingAccessCount, heldOutsideCount, heldOutsideNames,
    heldOutsideHoldsRole,
  });

  const selectable = selectableProps({ onSelect, selected, label: label ?? title });
  return (
    <td
      {...selectable}
      className={`text-center border-r border-b border-gray-100 dark:border-gray-700${selected ? ' outline outline-2 -outline-offset-2 outline-blue-600 dark:outline-blue-300' : ''}${onSelect ? ' cursor-pointer' : ''}`}
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
      {children}
    </td>
  );
}

// A cell that can be selected answers a click and Enter / Space, and says
// whether it is selected. Nothing for the matrix's own cells.
function selectableProps({ onSelect, selected, label }) {
  if (!onSelect) return {};
  return {
    role: 'button',
    tabIndex: 0,
    'aria-pressed': selected,
    'aria-label': label,
    onClick: onSelect,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(e); } },
  };
}

// The props a cell re-renders on; everything else (cellKey) is fixed per cell.
const COMPARED_PROPS = [
  'membershipTypes', 'managed', 'apColor', 'apCount', 'apNames', 'provisioningGap', 'gapExpected', 'overGrant',
  'extraAccessCount', 'missingAccessCount', 'heldOutsideCount', 'heldOutsideNames', 'heldOutsideHoldsRole',
  'onExplainInherited', 'onSelect', 'selected', 'label', 'children',
];

export default memo(MatrixCell, (prev, next) => COMPARED_PROPS.every(k => prev[k] === next[k]));