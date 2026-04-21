// ─── resource-cluster plugin ──────────────────────────────────────────────────
// Groups resources that share a "name stem" — common prefixes (SG_, DL_,
// M365_, …), environment suffixes (_P, _ACC, _TST, …) and role suffixes
// (_Admin, _Users, …) are stripped, and resources whose stems match are
// considered one logical cluster.
//
// Ported from the old risk-scoring buildClusters() path. The risk-scoring
// engine still reads the classifier-match table and computes per-resource
// scores, but clustering is now a separate concern exposed as a plugin so
// analysts can re-run it from the UI without a full risk score.
//
// Output:
//   - one Context per cluster (contextType='ResourceCluster',
//     targetType='Resource', variant='generated')
//   - one ContextMember per resource in the cluster
//
// Clusters of size < 2 are dropped — a single resource is not a cluster.

import { getGroupStem } from './stem.js';

export const plugin = {
  name: 'resource-cluster',
  displayName: 'Resource Cluster',
  description:
    'Groups resources by a normalised name stem. Prefixes (SG_, DL_, …), ' +
    'environment suffixes (_P, _ACC, …) and role suffixes (_Admin, _Users, …) ' +
    'are stripped so related resources from multiple systems cluster together.',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    properties: {
      scopeSystemId: {
        type: 'integer',
        description:
          'Systems.id — if set, only resources belonging to this system are clustered. Leave blank to cluster across all systems.',
      },
      minStemLength: {
        type: 'integer',
        default: 3,
        description: 'Stems shorter than this are ignored to avoid noise clusters.',
      },
      minMembers: {
        type: 'integer',
        default: 4,
        description: 'Drop clusters with fewer than this many members. Use a larger value to focus on meaningful groupings; a lower value (min 2) to see more fragmented clusters.',
      },
      rootName: {
        type: 'string',
        default: 'Resource Clusters',
        description: 'Display name of the synthetic root node — every cluster is attached under this.',
      },
    },
    required: [],
  },

  async run(params, { db }) {
    const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;
    const minStemLength = Math.max(parseInt(params.minStemLength, 10) || 3, 1);
    const minMembers    = Math.max(parseInt(params.minMembers, 10)    || 4, 2);
    const rootName      = (params.rootName || 'Resource Clusters').slice(0, 500);

    const rows = (await db.query(
      `SELECT id, "displayName", "systemId"
         FROM "Resources"
        WHERE $1::int IS NULL OR "systemId" = $1`,
      [scopeSystemId],
    )).rows;

    // Group by stem. One entry per stem → array of resource rows.
    const byStem = new Map();
    for (const r of rows) {
      const stem = getGroupStem(r.displayName || '');
      if (!stem || stem.length < minStemLength) continue;
      if (!byStem.has(stem)) byStem.set(stem, []);
      byStem.get(stem).push(r);
    }

    // Synthetic root. Everything attaches here so the tree selector shows
    // one "Resource Clusters" entry rather than N flat roots.
    const rootExt = 'root';
    const contexts = [{
      externalId: rootExt,
      displayName: rootName,
      description: `Stem-based clusters of resources (min ${minMembers} members per cluster).`,
      contextType: 'ResourceCluster',
    }];
    const members = [];
    for (const [stem, group] of byStem) {
      if (group.length < minMembers) continue;
      contexts.push({
        externalId: `stem:${stem}`,
        displayName: stem,
        description: `${group.length} resources sharing name stem "${stem}"`,
        contextType: 'ResourceCluster',
        parentExternalId: rootExt,
      });
      for (const r of group) {
        members.push({
          contextExternalId: `stem:${stem}`,
          memberId: r.id,
        });
      }
    }

    return { contexts, members };
  },
};
