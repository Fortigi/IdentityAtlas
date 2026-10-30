// system-membership-principals plugin.
//
// Emits one generated context per connected system, named after the system,
// holding that system's principals as members — so the matrix can be scoped to
// the accounts that came from a single source system. The resource-side mirror
// is system-membership-resources; both share system-membership.helpers.js.

import { defineSystemMembershipPlugin } from './system-membership.helpers.js';

const DEFAULTS = {
  rootName: 'Principals by system',
  rootType: 'SystemMembership',
  childType: 'SystemMembership',
  noun: 'principals',
};

/** @type {import('./types.js').ContextPlugin} */
export default defineSystemMembershipPlugin({
  name: 'system-membership-principals',
  displayName: 'Principals by System',
  description:
    'One context per connected system, named after the system, holding that system\'s principals as ' +
    'members. Lets you scope the matrix to the accounts loaded from a single source system. Re-running ' +
    'reconciles: a new system gets a context, a removed system\'s context disappears.',
  targetType: 'Principal',
  defaults: DEFAULTS,
});
