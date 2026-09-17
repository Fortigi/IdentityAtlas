// The built-in report templates.
//
// This is the ONE line adding a report costs on top of its own template file:
// import it here and put it in the array. Nothing else in the engine — not the
// registry, not the routes, not the UI — knows a template by name.

import accessOutsideRoles from './access-outside-roles.js';
import disabledAccountsWithAccess from './disabled-accounts-with-access.js';
import emptyGroups from './empty-groups.js';
import missingManagers from './missing-managers.js';
import neverSignedIn from './never-signed-in.js';
import orphanedAccounts from './orphaned-accounts.js';
import privilegedAccounts from './privileged-accounts.js';
import staleAccounts from './stale-accounts.js';
import staleGuestAccounts from './stale-guest-accounts.js';

/** @type {import('../types.js').ReportTemplate[]} */
export const BUILT_IN_REPORTS = [
  accessOutsideRoles,
  disabledAccountsWithAccess,
  emptyGroups,
  missingManagers,
  neverSignedIn,
  orphanedAccounts,
  privilegedAccounts,
  staleAccounts,
  staleGuestAccounts,
];
