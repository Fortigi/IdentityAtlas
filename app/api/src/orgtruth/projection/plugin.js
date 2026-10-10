// Organisation truth — the projection into contexts, Resource members.
//
// One generated context per open, accepted org entity (under a root and a node
// per entity type), holding the Resources (groups, roles, apps…) linked to it
// directly or through a one-hop accepted relation. Its twin with Principal
// members is pluginPrincipals.js; the shared logic is in project.js and the
// queries in projectionSql.js. Refreshed after every crawl by the runner like
// every generated tree, and enqueued at the end of every org import.
//
// Parameters:
//   entityTypes   which org entity types become contexts (default: all that have accepted links)
import { makeOrgTruthPlugin } from './project.js';

export default makeOrgTruthPlugin({
  name: 'org-truth',
  displayName: 'Additional information',
  description: 'One context per organisation entity (project, asset, team, data domain), with the resources linked to it, or to the entities it is related to, as members.',
  targetType: 'Resource',
});
