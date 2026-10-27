// Authorization workbench — how a cell looks. Every state has a glyph as well as
// a colour (never colour alone), and a title that says it in words. Pure.

import { MARKS } from './workbench.model';

const GRANT = {
  Direct: { glyph: '■', label: 'Direct', cls: 'bg-indigo-600 text-white dark:bg-indigo-400 dark:text-gray-900' },
  Indirect: { glyph: '▪', label: 'Indirect (through a group)', cls: 'bg-indigo-200 text-indigo-900 dark:bg-indigo-800 dark:text-indigo-100' },
  Eligible: { glyph: '□', label: 'Eligible', cls: 'bg-white text-indigo-700 ring-1 ring-inset ring-indigo-400 dark:bg-gray-900 dark:text-indigo-300' },
};
const OTHER_GRANT = { glyph: '•', label: 'Held', cls: 'bg-slate-300 text-slate-800 dark:bg-slate-600 dark:text-slate-100' };

export const IMPACT = {
  covered: { glyph: '✓', label: 'Covered — observed, and the candidate would explain it', cls: 'bg-emerald-500 text-white dark:bg-emerald-400 dark:text-gray-900' },
  gain: { glyph: '+', label: 'Potential gain — not observed, the candidate would add it', cls: 'bg-amber-50 text-amber-800 border border-dashed border-amber-500 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-400' },
  outside: { glyph: '○', label: 'Outside the candidate — observed, not covered; not a removal', cls: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
  other: { glyph: 'O', label: 'Other context (marked)', cls: 'bg-purple-200 text-purple-900 dark:bg-purple-800 dark:text-purple-100' },
  unrelated: { glyph: 'U', label: 'Unrelated to this investigation (marked)', cls: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
  investigate: { glyph: '?', label: 'Needs investigation (marked)', cls: 'bg-orange-200 text-orange-900 dark:bg-orange-800 dark:text-orange-100' },
  held: { glyph: '·', label: 'Held by someone who is not a member of the candidate', cls: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-200' },
};

export const GRANT_LEGEND = Object.values(GRANT);
export const IMPACT_LEGEND = ['covered', 'gain', 'outside', 'other', 'unrelated', 'investigate'].map(k => ({ key: k, ...IMPACT[k] }));

/**
 * What one cell shows: { glyph, cls, title } or null for an empty cell.
 * Without the overlay: the grant (and a mark, by its letter). With it: the impact.
 */
export function cellLook({ cell, mark, impact, overlay }) {
  if (overlay && impact) {
    const look = IMPACT[impact];
    return { glyph: look.glyph, cls: look.cls, title: `${look.label}${grantSuffix(cell)}` };
  }
  if (!cell) return null;
  const grant = GRANT[cell.type] ?? OTHER_GRANT;
  const markLook = mark ? MARKS[mark] : null;
  return {
    glyph: markLook ? markLook.short : grant.glyph,
    cls: grant.cls,
    title: `${grant.label}${viaSuffix(cell)}${markLook ? ` — marked: ${markLook.label}` : ''}`,
  };
}

const grantSuffix = (cell) => (cell ? ` (${(GRANT[cell.type] ?? OTHER_GRANT).label}${viaSuffix(cell)})` : '');
const viaSuffix = (cell) => (cell?.viaRoles?.length ? ` · through ${cell.viaRoles.length} business role${cell.viaRoles.length > 1 ? 's' : ''}` : '');
