// The built-in report templates.
//
// This is the ONE line adding a report costs on top of its own template file:
// import it here and put it in the array. Nothing else in the engine — not the
// registry, not the routes, not the UI — knows a template by name.

import orphanedAccounts from './orphaned-accounts.js';

/** @type {import('../types.js').ReportTemplate[]} */
export const BUILT_IN_REPORTS = [
  orphanedAccounts,
];
