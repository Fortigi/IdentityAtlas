import { memo } from 'react';
import { TYPE_COLORS } from '@ui/utils/colors';
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

function MatrixCell({ cellKey, membershipTypes, managed, apColor, apCount, apNames, provisioningGap, gapExpected, onExplainInherited }) {
  const hasMembership = membershipTypes && membershipTypes.size > 0;
  const single = hasMembership && membershipTypes.size === 1;
  const { title, bgColor } = describeCell({
    hasMembership, membershipTypes, managed, apColor, apNames, provisioningGap, gapExpected,
  });
  const needsRelative = apCount > 1 || provisioningGap;

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
      {provisioningGap && (
        <span
          className="absolute top-0 left-0 flex items-center justify-center w-2.5 h-2.5 rounded-full text-[6px] font-bold leading-none bg-amber-500 text-white border border-amber-600"
          style={{ zIndex: 2 }}
        >
          !
        </span>
      )}
      {apCount > 1 && (
        <span
          className="absolute -top-1 -right-1 flex items-center justify-center w-3 h-3 rounded-full text-[7px] font-bold leading-none bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-500 shadow-sm"
          style={{ zIndex: 1 }}
        >
          {apCount}
        </span>
      )}
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
    prev.onExplainInherited === next.onExplainInherited
  );
});
