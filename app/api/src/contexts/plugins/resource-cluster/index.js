// ─── resource-cluster plugin (token-based) ────────────────────────────────────
//
// Groups resources that share a significant token in their display name. A
// "significant" token is one that survives the tokenizer — splitting on
// -_./|\\\s, dropping short / numeric / stopword fragments. Names like
// "SG_APP_HAMIS_Admins_P" and "GRP-HAMIS-Readers-TST" both survive as
// {hamis} and land in the same HAMIS cluster, regardless of which prefix
// or suffix the originating system put around them.
//
// A resource can belong to multiple clusters — a group named
// "HAMIS_FINANCE_Admins" contributes to both a HAMIS cluster and a FINANCE
// cluster (if both tokens clear the minMembers threshold). The plugin does
// not try to pick "the" cluster per resource — overlap is the point, and
// the analyst uses the cluster list to find related resources.
//
// The older stem-stripper implementation lived here before and missed any
// pattern that didn't match the hardcoded prefix/suffix whitelist. That was
// the complaint that drove this rewrite.

import { tokenize, buildStopwords, prettifyToken } from './tokenize.js';

export const plugin = {
  name: 'resource-cluster',
  displayName: 'Resource Cluster',
  description:
    'Groups resources by the significant tokens in their display name. ' +
    'Splits on separators, drops role/env/type/filler stopwords, and creates a ' +
    'cluster per remaining token that appears in at least `minMembers` resources. ' +
    'A resource can belong to multiple clusters.',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    properties: {
      scopeSystemId: {
        type: 'integer',
        description: 'Systems.id — if set, only resources from this system are clustered.',
      },
      minMembers: {
        type: 'integer',
        default: 4,
        description: 'Drop clusters with fewer than this many members. Lower = more clusters including noisy ones; higher = only strong signals.',
      },
      minTokenLength: {
        type: 'integer',
        default: 3,
        description: 'Tokens shorter than this are ignored (drops "p", "it", numerics).',
      },
      maxTokenCoverage: {
        type: 'number',
        default: 0.7,
        description: 'Reject tokens that appear in more than this fraction of resources (0..1). Filters out tokens so generic they would swallow the whole dataset.',
      },
      additionalStopwords: {
        type: 'array',
        description: 'Extra tokens to ignore on top of the defaults (role / env / type / filler). Lowercased at parse time.',
        items: { type: 'string' },
      },
      rootName: {
        type: 'string',
        default: 'Resource Clusters',
        description: 'Display name of the synthetic root node — every cluster attaches here.',
      },
    },
    required: [],
  },

  async run(params, { db }) {
    const scopeSystemId     = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;
    const minMembers        = Math.max(parseInt(params.minMembers, 10) || 4, 2);
    const minTokenLength    = Math.max(parseInt(params.minTokenLength, 10) || 3, 1);
    const maxTokenCoverage  = Number.isFinite(params.maxTokenCoverage) ? params.maxTokenCoverage : 0.7;
    const rootName          = (params.rootName || 'Resource Clusters').slice(0, 500);
    const stopwords         = buildStopwords(params.additionalStopwords);

    const rows = (await db.query(
      `SELECT id, "displayName"
         FROM "Resources"
        WHERE $1::int IS NULL OR "systemId" = $1`,
      [scopeSystemId],
    )).rows;

    if (rows.length === 0) {
      return { contexts: [], members: [] };
    }

    // Build: token -> array of resource ids.
    const byToken = new Map();
    for (const r of rows) {
      const tokens = tokenize(r.displayName || '', { minTokenLength, stopwords });
      for (const t of tokens) {
        if (!byToken.has(t)) byToken.set(t, []);
        byToken.get(t).push(r.id);
      }
    }

    // Apply the two filters: (a) minimum member count, (b) maximum coverage
    // (don't let a token that appears in 80% of all resources become a
    // cluster — that's just noise).
    const total = rows.length;
    const coverageCap = Math.max(minMembers, Math.floor(total * maxTokenCoverage));

    const rootExt = 'root';
    const contexts = [{
      externalId: rootExt,
      displayName: rootName,
      description: `Token-based clusters of resources (min ${minMembers} members, max ${Math.round(maxTokenCoverage * 100)}% coverage per token).`,
      contextType: 'ResourceCluster',
    }];
    const members = [];

    // Sort by size desc so cluster-detail ordering is predictable even
    // without the tree sort the runner already applies.
    const sortedTokens = [...byToken.entries()]
      .filter(([, ids]) => ids.length >= minMembers && ids.length <= coverageCap)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [token, ids] of sortedTokens) {
      const externalId = `token:${token}`;
      contexts.push({
        externalId,
        displayName: prettifyToken(token),
        description: `${ids.length} resources whose name contains "${token}".`,
        contextType: 'ResourceCluster',
        parentExternalId: rootExt,
        extendedAttributes: { token, memberCount: ids.length },
      });
      for (const rid of ids) {
        members.push({ contextExternalId: externalId, memberId: rid });
      }
    }

    return { contexts, members };
  },
};
