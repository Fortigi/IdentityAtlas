// system-membership-resources plugin.
//
// The resource-side mirror of system-membership-principals: one generated
// context per connected system, named after the system, holding that system's
// resources as members. Both share system-membership.helpers.js.

import { defineSystemMembershipPlugin } from './system-membership.helpers.js';

const DEFAULTS = {
  rootName: 'Resources by system',
  rootType: 'SystemMembership',
  childType: 'SystemMembership',
  noun: 'resources',
};

/** @type {import('./types.js').ContextPlugin} */
export default defineSystemMembershipPlugin({
  name: 'system-membership-resources',
  displayName: 'Resources by System',
  description:
    'One context per connected system, named after the system, holding that system\'s resources as ' +
    'members. Lets you scope the matrix to the resources loaded from a single source system. Re-running ' +
    'reconciles: a new system gets a context, a removed system\'s context disappears.',
  targetType: 'Resource',
  defaults: DEFAULTS,
});
