// The relative-permission grid (Admin → Roles & Permissions → Relative
// permissions), the pure part: which columns there are, what a row is called,
// and what one tick does to the grid. The API decides what each cell means
// (app/api/src/auth/relativePermissions.js) and normalizes what is saved; this
// only mirrors its one dependency rule so a click shows the right state at once.

import { categoryMeta } from '@ui/utils/contextStyles';

export const OWNER_ROLES = ['Accountable', 'Responsible'];

// Every capability any row may have, in column order.
export const CAPABILITY_COLUMNS = [
  { key: 'view', label: 'Sign in & view', hint: 'They can sign in without an Identity Atlas role and see it, read-only.' },
  { key: 'subUnits', label: 'Sub-units', hint: 'Also every sub-unit below it, at any depth.' },
  { key: 'mcp', label: 'MCP', hint: 'Ask about it from an AI assistant through the MCP server, seeing exactly the same.' },
  { key: 'review', label: 'Composition review', hint: 'Review the business role step by step and sign the review, without the certification permission.' },
];

// Capabilities that only count while `view` is on (the API clears them otherwise).
const NEEDS_VIEW = new Set(['subUnits', 'mcp']);
export const needsView = (capability) => NEEDS_VIEW.has(capability);

/** The heading a row group gets: the template's plural name, or "Business roles". */
export function subjectLabel(subject) {
  return subject === 'BusinessRole' ? 'Business roles' : categoryMeta(subject).groupLabel;
}

/** Is this cell ticked? */
export const isOn = (policy, subject, role, capability) => policy?.[subject]?.[role]?.[capability] === true;

/**
 * The grid after one tick: a copy with that cell set. Turning `view` off turns
 * off what depends on it in the same row.
 */
export function withCell(policy, subject, role, capability, value) {
  const row = { ...(policy?.[subject]?.[role] || {}), [capability]: value };
  if (capability === 'view' && !value) for (const cap of Object.keys(row)) if (needsView(cap)) row[cap] = false;
  return { ...policy, [subject]: { ...(policy?.[subject] || {}), [role]: row } };
}
