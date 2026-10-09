// Organisation truth — the projection into contexts (owned by workstream T4).
//
// A context plugin like any other (contexts/plugins/types.js): it reads the
// accepted org entities, relations and links, and emits one generated context
// per org entity of the configured types, with the linked system objects as
// members. "Project Atlas" becomes a Resource context holding the groups its
// linked owner/… relations point at; a team becomes an Identity context of the
// people linked to it. Refreshed after every crawl by the runner like every
// generated tree, so new links show up without a second mechanism.
//
// Parameters:
//   entityTypes   which org entity types become contexts (default: all that have links)
//   targetType    'Resource' | 'Identity' | 'Principal' — which linked objects become members
export default {
  name: 'org-truth',
  displayName: 'Organisation truth',
  description: 'One context per organisation entity (project, asset, team, data domain), with the system objects linked to it as members.',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    properties: {
      entityTypes: { type: 'array', items: { type: 'string' }, description: 'Organisation entity types to project; empty = every type that has accepted links.' },
    },
  },
  async run(_params, ctx) {
    ctx?.log?.('org-truth projection: not built yet (workstream T4)');
    return { contexts: [], members: [] };
  },
};
