import { memo } from 'react';
import { TYPE_COLORS } from '../../utils/colors';

function MatrixCell({ cellKey, membershipTypes, managed, apColor, apCount, apNames, provisioningGap, gapExpected }) {
  const hasMembership = membershipTypes && membershipTypes.size > 0;

  // Background: AP color for managed cells only; unmanaged cells stay white
  let bgColor;
  if (hasMembership && managed) {
    bgColor = apColor || '#dbeafe';
  }

  // Tooltip
  let title;
  if (hasMembership) {
    const types = [...membershipTypes].join(', ');
    if (apNames && apNames.length > 0) {
      title = `${types}\nManaged by: ${apNames.join(', ')}`;
    } else if (managed) {
      title = `${types} (managed by business role)`;
    } else {
      title = types;
    }
    if (provisioningGap) {
      const expectedLabel = gapExpected ? ` (expects ${gapExpected})` : '';
      title += `\n\u26a0 Provisioning gap: user lacks the membership type specified by the business role${expectedLabel}`;
    }
  } else if (provisioningGap) {
    // AP manages this cell but user has no membership at all
    const expectedLabel = gapExpected ? ` ${gapExpected}` : '';
    title = `\u26a0 Provisioning gap: business role expects${expectedLabel} membership but user has none`;
    if (apNames && apNames.length > 0) {
      title += `\nManaged by: ${apNames.join(', ')}`;
    }
    bgColor = apColor || '#dbeafe';
  }

  const needsRelative = apCount > 1 || provisioningGap;

  return (
    <td
      className="px-0 py-0 text-center border-r border-b border-gray-100"
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
            return ind ? (
              <span
                key={type}
                className={`inline-block rounded-sm text-center font-bold ${membershipTypes.size === 1 ? 'w-4 h-4 text-[9px] leading-4' : 'w-[9px] h-[14px] text-[7px] leading-[14px]'}`}
                style={{ backgroundColor: ind.bg, color: ind.text }}
              >
                {ind.letter}
              </span>
            ) : (
              <span key={type} className="text-[7px] font-bold text-green-800">?</span>
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
          className="absolute -top-1 -right-1 flex items-center justify-center w-3 h-3 rounded-full text-[7px] font-bold leading-none bg-white text-gray-700 border border-gray-300 shadow-sm"
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
    prev.gapExpected === next.gapExpected
  );
});
