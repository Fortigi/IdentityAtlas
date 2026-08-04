import { memo } from 'react';
import { TYPE_COLORS } from '@ui/utils/colors';
import { extraAccessTitle } from './cellMarkers';

// Access that a folded business role hides but does NOT grant — the subject
// holds it on one of the folded resources through some other route. Shown as a
// count on the folded role's own cell so folding can never quietly swallow the
// very thing a role-mining review is hunting for. Exported so the aggregate
// (folded-column) cell can render the same marker.
export function ExtraAccessBadge({ count }) {
  if (!count) return null;
  return (
    <span
      className="absolute -bottom-1 -right-1 flex items-center justify-center w-3 h-3 rounded-full text-[7px] font-bold leading-none bg-rose-600 text-white border border-rose-700 shadow-sm"
      style={{ zIndex: 2 }}
      title={extraAccessTitle(count)}
    >
      {count}
    </span>
  );
}

// Everything the cell says on hover: how the access is held, which business
// roles govern it, and any marker it carries. Pulled out of the component so
// the wording lives in one readable place.
function cellTitle({ membershipTypes, managed, apNames, provisioningGap, gapExpected, extraAccessCount }) {
  const parts = [];
  const managedBy = apNames?.length ? `Managed by: ${apNames.join(', ')}` : null;
  if (membershipTypes?.size) {
    const types = [...membershipTypes].join(', ');
    parts.push(managedBy ? `${types}\n${managedBy}` : (managed ? `${types} (managed by business role)` : types));
    if (provisioningGap) {
      const expected = gapExpected ? ` (expects ${gapExpected})` : '';
      parts.push(`\u26a0 Provisioning gap: user lacks the membership type specified by the business role${expected}`);
    }
  } else if (provisioningGap) {
    // A business role manages this cell but the subject has no membership at all.
    const expected = gapExpected ? ` ${gapExpected}` : '';
    parts.push(`\u26a0 Provisioning gap: business role expects${expected} membership but user has none`);
    if (managedBy) parts.push(managedBy);
  }
  if (extraAccessCount > 0) parts.push(extraAccessTitle(extraAccessCount));
  return parts.length ? parts.join('\n') : undefined;
}

function MatrixCell({ cellKey, membershipTypes, managed, apColor, apCount, apNames, provisioningGap, gapExpected, extraAccessCount = 0, onExplainInherited }) {
  const hasMembership = membershipTypes && membershipTypes.size > 0;

  // Background: the business role's colour on a governed cell — and on a
  // provisioning gap, which is governance without the membership. An ungoverned
  // cell stays white.
  const bgColor = (hasMembership ? managed : provisioningGap) ? (apColor || '#dbeafe') : undefined;

  const title = cellTitle({ membershipTypes, managed, apNames, provisioningGap, gapExpected, extraAccessCount });

  const needsRelative = apCount > 1 || provisioningGap || extraAccessCount > 0;

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
          {[...membershipTypes].map(type => {
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
          })}
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
      <ExtraAccessBadge count={extraAccessCount} />
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
    prev.extraAccessCount === next.extraAccessCount &&
    prev.onExplainInherited === next.onExplainInherited
  );
});
