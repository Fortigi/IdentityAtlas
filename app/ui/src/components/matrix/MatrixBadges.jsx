import { TYPE_COLORS } from '@ui/utils/colors';

// The matrix's badges, in one place for every screen that shows access the
// matrix way (docs/architecture/matrix.md "Badge collapse"): the D / I / E swatch
// for how access is held (TYPE_COLORS), and the "BR" chip for a business role.
// The matrix cell, the matrix legend and the Authorization workbench render
// these, so the signs can never drift apart.

// The BR chip's look; a clickable chip (the matrix row's) adds its hover on top.
export const BUSINESS_ROLE_CHIP_CLASS =
  'inline-flex px-1 items-center justify-center rounded bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700 font-medium shrink-0';

/**
 * One membership-type swatch (D / I / E). `single`: the full 16px badge; else the
 * half-width one two types share in a cell. `decorative`: hidden from assistive
 * tech (a legend, or a cell whose button already says it). Indirect becomes
 * clickable when `onExplainInherited` is given, so the analyst can trace it.
 */
export function MembershipBadge({ type, single = true, decorative = false, cellKey, onExplainInherited }) {
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
      aria-hidden={decorative ? 'true' : undefined}
      className={`inline-block rounded-sm text-center font-bold shrink-0 ${sizeClass} ${clickClass}`}
      style={{ backgroundColor: ind.bg, color: ind.text }}
    >
      {ind.letter}
    </span>
  );
}

/** The "BR" chip of a business role ("BR+2" for more than one). Decorative: its context says what it is. */
export function BusinessRoleBadge({ label = 'BR', className = 'text-[9px]' }) {
  return <span className={`${BUSINESS_ROLE_CHIP_CLASS} ${className}`} aria-hidden="true">{label}</span>;
}
