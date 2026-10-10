// Organisation truth — the projection into contexts, Principal members.
//
// Same tree as plugin.js, with accounts as members: the Principals linked to an
// entity, the accounts of the Identities linked to it, and the same for the
// entities it is related to (one hop). A project context here therefore holds
// its owner's account(s). Shared logic in project.js.
import { makeOrgTruthPlugin } from './project.js';

export default makeOrgTruthPlugin({
  name: 'org-truth-principals',
  displayName: 'Additional information (accounts)',
  description: 'One context per organisation entity (project, asset, team, data domain), with the accounts linked to it, or to the entities it is related to (an owner, a team member), as members.',
  targetType: 'Principal',
});
