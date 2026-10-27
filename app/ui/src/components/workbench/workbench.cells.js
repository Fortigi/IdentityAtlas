// Authorization workbench — how a cell looks. Pure.
//
// Two layers, never mixed:
//   1. the ACCESS, exactly as the matrix shows it: the D / I / E badge
//      (components/matrix/MatrixBadges.jsx, TYPE_COLORS) — what the person holds;
//   2. the WORKBENCH's own sign on top: a small corner mark and a ring — a mark the
//      analyst set (other context, unrelated, needs investigation) or, with the
//      overlay on, what the candidate does to the cell (covered, gain, outside).
// Every sign has a glyph and a title in words, never colour alone.

import { MARKS } from './workbench.model';

export const GRANT_LABEL = { Direct: 'Direct', Indirect: 'Indirect (through a group)', Eligible: 'Eligible' };

export const IMPACT = {
  covered: { glyph: '✓', label: 'Covered — observed, and the candidate would explain it', mark: 'bg-emerald-600 text-white dark:bg-emerald-400 dark:text-gray-900', ring: 'ring-2 ring-inset ring-emerald-500 dark:ring-emerald-400' },
  gain: { glyph: '+', label: 'Potential gain — not observed, the candidate would add it', mark: 'bg-amber-500 text-white dark:bg-amber-400 dark:text-gray-900', ring: 'border border-dashed border-amber-500 bg-amber-50 dark:border-amber-400 dark:bg-amber-900/30' },
  outside: { glyph: '○', label: 'Outside the candidate — observed, not covered; not a removal', mark: 'bg-slate-500 text-white dark:bg-slate-300 dark:text-gray-900', ring: 'ring-1 ring-inset ring-slate-400 dark:ring-slate-500' },
  other: { glyph: 'O', label: 'Other context (marked)', mark: 'bg-purple-600 text-white dark:bg-purple-400 dark:text-gray-900', ring: 'ring-1 ring-inset ring-purple-500 dark:ring-purple-400' },
  unrelated: { glyph: 'U', label: 'Unrelated to this investigation (marked)', mark: 'bg-gray-500 text-white dark:bg-gray-300 dark:text-gray-900', ring: 'ring-1 ring-inset ring-gray-400 dark:ring-gray-500' },
  investigate: { glyph: '?', label: 'Needs investigation (marked)', mark: 'bg-orange-600 text-white dark:bg-orange-400 dark:text-gray-900', ring: 'ring-1 ring-inset ring-orange-500 dark:ring-orange-400' },
  held: { glyph: null, label: 'Held by someone who is not a member of the candidate', mark: null, ring: '' },
};

export const IMPACT_LEGEND = ['covered', 'gain', 'outside', 'other', 'unrelated', 'investigate'].map(k => ({ key: k, ...IMPACT[k] }));
export const MARK_LEGEND = Object.keys(MARKS).map(k => ({ key: k, ...IMPACT[k] }));

/**
 * What one cell shows: { badge, sign, dim, title } or null for an empty cell.
 *   badge  the grant type for the matrix's D / I / E badge (null: not held)
 *   sign   the workbench layer on top: { glyph, mark, ring } or null
 *   dim    held by someone outside the candidate (overlay on): the badge fades
 * Without the overlay the sign is the analyst's mark; with it, the impact.
 */
export function cellLook({ cell, mark, impact, overlay }) {
  const kind = overlay ? impact : mark;
  if (!cell && !kind) return null;
  const sign = kind && IMPACT[kind].glyph ? IMPACT[kind] : null;
  const access = cell ? `${GRANT_LABEL[cell.type] ?? 'Held'}${viaSuffix(cell)}` : 'Not held';
  return {
    badge: cell ? cell.type : null,
    sign,
    dim: !!overlay && impact === 'held',
    title: kind ? `${IMPACT[kind].label} — ${access}` : access,
  };
}

const viaSuffix = (cell) => (cell?.viaRoles?.length ? ` · through ${cell.viaRoles.length} business role${cell.viaRoles.length > 1 ? 's' : ''}` : '');
