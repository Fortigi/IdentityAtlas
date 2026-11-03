// What a context's page header offers, per template — the actions that used to
// be a grid of cards. Pure; the header (ContextDetailHeader.jsx) draws them.
//
// The report is the reader's main action and stays a visible button for
// everyone, a context owner's read-only page included (they may export their own
// context): an application's entitlement report (every entitlement held there and
// who holds it), a unit of accounts or people's unit report (its members, their
// entitlement counts and attributes). A unit of resources and the other
// templates have none. "View in matrix" opens a page of the app, so a read-only
// shell (which cannot reach it) does not offer it.

import { profileFor } from '@ui/components/contexts/profiles/profiles';

const ENTITLEMENT_REPORT = {
  report: 'application-access-review',
  title: 'Every entitlement held here and who holds it, with counts and owner, as a spreadsheet.',
};
const UNIT_REPORT = {
  report: 'unit-members',
  title: 'Everyone in this unit with their details, how many entitlements each holds and every attribute, as a spreadsheet.',
};
const PEOPLE_TARGETS = new Set(['Principal', 'Identity']);

/** The report this context's header downloads ({ report, title }), or null. Pure. */
export function reportFor(attrs) {
  if (attrs?.contextCategory === 'LogicalApplication') return ENTITLEMENT_REPORT;
  if (attrs?.contextCategory === 'OrganizationalUnit' && PEOPLE_TARGETS.has(attrs.targetType)) return UNIT_REPORT;
  return null;
}

/** Whether the ⋯ menu offers "View in matrix": a unit or an application, outside a read-only shell. Pure. */
export function offersMatrix(attrs, { sharedView = false } = {}) {
  return !sharedView && !!profileFor(attrs?.contextCategory);
}

const OWNER_MATRICES = {
  people: { label: 'Team matrix', title: 'Everyone in this unit and the units below it as a row, and what each of them holds' },
  resources: { label: 'Application matrix', title: 'What is held here as columns, and everyone who holds it as a row' },
};

/**
 * The matrix the header offers a context owner on their owner page
 * (ownerScope), for a context in that scope — { label, title } — or null: the
 * team matrix on a unit of accounts or people, the application matrix on a
 * context of resources. The API bounds either to the context whatever is asked
 * (app/api/src/auth/ownerAccess/matrixFilter.js). Pure.
 */
export function ownerMatrixFor(attrs, { ownerScope = null } = {}) {
  if (!ownerScope || !attrs || !ownerScope.has(String(attrs.id).toLowerCase())) return null;
  if (PEOPLE_TARGETS.has(attrs.targetType)) return OWNER_MATRICES.people;
  if (attrs.targetType === 'Resource') return OWNER_MATRICES.resources;
  return null;
}
