// Authorization workbench — the words for the candidate's impact, and the
// look of the marks only the workbench has. Pure.
//
// A cell itself is the matrix's (MatrixCell; workbench.roles.js maps the
// candidate onto it): covered is the role's colour, a potential gain the
// matrix's provisioning-gap marker, outside the candidate a plain cell. What
// has no matrix equivalent — the analyst's marks: other context, unrelated,
// needs investigation — sits on top as a small corner sign (mark).

import { MARKS } from './workbench.model';

export const IMPACT = {
  covered: { glyph: '✓', label: 'Covered — observed, and the candidate would explain it', mark: 'bg-emerald-600 text-white dark:bg-emerald-400 dark:text-gray-900', ring: 'ring-2 ring-inset ring-emerald-500 dark:ring-emerald-400' },
  gain: { glyph: '+', label: 'Potential gain — not observed, the candidate would add it', mark: 'bg-amber-500 text-white dark:bg-amber-400 dark:text-gray-900', ring: 'border border-dashed border-amber-500 bg-amber-50 dark:border-amber-400 dark:bg-amber-900/30' },
  outside: { glyph: '○', label: 'Outside the candidate — observed, not covered; not a removal', mark: 'bg-slate-500 text-white dark:bg-slate-300 dark:text-gray-900', ring: 'ring-1 ring-inset ring-slate-400 dark:ring-slate-500' },
  other: { glyph: 'O', label: 'Other context (marked)', mark: 'bg-purple-600 text-white dark:bg-purple-400 dark:text-gray-900', ring: 'ring-1 ring-inset ring-purple-500 dark:ring-purple-400' },
  unrelated: { glyph: 'U', label: 'Unrelated to this investigation (marked)', mark: 'bg-gray-500 text-white dark:bg-gray-300 dark:text-gray-900', ring: 'ring-1 ring-inset ring-gray-400 dark:ring-gray-500' },
  investigate: { glyph: '?', label: 'Needs investigation (marked)', mark: 'bg-orange-600 text-white dark:bg-orange-400 dark:text-gray-900', ring: 'ring-1 ring-inset ring-orange-500 dark:ring-orange-400' },
  held: { glyph: null, label: 'Held by someone who is not a member of the candidate', mark: null, ring: '' },
};

export const MARK_LEGEND = Object.keys(MARKS).map(k => ({ key: k, ...IMPACT[k] }));

