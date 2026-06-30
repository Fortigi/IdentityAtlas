// risky-consent plugin.
//
// Surfaces principals who have granted (or hold) a RISKY OAuth consent. A
// DelegatedPermission resource is one per (client app → scope → API) and an
// AppRole resource is one per application permission; ResourceAssignments link
// the consenting/holding principal to them. We classify each consent's
// permission string with the curated risk map and emit one context per risk
// tier ("Risky Consent — High" / "— Medium"), with every principal holding a
// consent at that tier as a member. Build a matrix on these contexts to answer
// "who granted a risky consent?".
//
// Phase 1: deterministic, curated-map only — no external calls. (A later phase
// adds OAuthSentry app-reputation lookups + typo-squat heuristics; the client
// appId is reachable via clientSpId → Principal → extendedAttributes.appId.)

import * as db from '../../db/connection.js';
import { classifyPermission } from './riskyConsentRiskMap.js';

const TIER_EXTERNAL_ID = { High: 'risky-consent:High', Medium: 'risky-consent:Medium', Low: 'risky-consent:Low' };

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'risky-consent',
  displayName: 'Risky Consent',
  description:
    'Classifies delegated (OAuth) and application permission consents by risk and creates one context per risk tier (High/Medium), with each principal that holds such a consent as a member. Build a matrix on these to find who granted risky consent.',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    properties: {
      scopeSystemId: {
        type: 'integer',
        description: 'Restrict to consents recorded in this system. Omit to include all systems.',
      },
      includeAppRoles: {
        type: 'boolean',
        description: 'Also classify application permissions (AppRole), not just delegated scopes. Default true.',
      },
      enabledTiers: {
        type: 'array',
        items: { type: 'string', enum: ['High', 'Medium', 'Low'] },
        description: 'Which risk tiers to emit a context for. Default ["High","Medium"].',
      },
      unknownTier: {
        type: 'string',
        enum: ['High', 'Medium', 'Low'],
        description: 'Tier for permissions not in the risk map and matching no pattern. Default "Low".',
      },
    },
  },

  async run(params, ctx) {
    const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;
    const includeAppRoles = params.includeAppRoles !== false;
    const enabledTiers =
      Array.isArray(params.enabledTiers) && params.enabledTiers.length ? params.enabledTiers : ['High', 'Medium'];
    const unknownTier = params.unknownTier || 'Low';

    const types = includeAppRoles ? ['DelegatedPermission', 'AppRole'] : ['DelegatedPermission'];
    const args = [types];
    let scopeClause = '';
    if (scopeSystemId) {
      args.push(scopeSystemId);
      scopeClause = ` AND ra."systemId" = $${args.length}`;
    }

    // One row per (principal, consent). The permission string is the delegated
    // scope or, for application permissions, the appRoleValue.
    const rows = (await db.query(
      `SELECT DISTINCT ra."principalId" AS "principalId",
              COALESCE(r."extendedAttributes"->>'scope', r."extendedAttributes"->>'appRoleValue') AS "permission"
         FROM "ResourceAssignments" ra
         JOIN "Resources" r ON r.id = ra."resourceId"
        WHERE r."resourceType" = ANY($1)
          AND ra."principalId" IS NOT NULL
          AND ra."deletedAt" IS NULL
          AND r."deletedAt" IS NULL${scopeClause}`,
      args,
    )).rows;

    if (rows.length === 0) {
      ctx.log?.('No delegated/application consents found — nothing to do.');
      return { contexts: [], members: [] };
    }

    // Tier → set of principalIds holding ≥1 consent at that tier.
    const membersByTier = { High: new Set(), Medium: new Set(), Low: new Set() };
    for (const row of rows) {
      if (!row.permission || !row.principalId) continue;
      const tier = classifyPermission(row.permission, { unknownTier });
      if (!enabledTiers.includes(tier)) continue;
      membersByTier[tier]?.add(row.principalId);
    }

    const contexts = [];
    const members = [];
    for (const tier of enabledTiers) {
      const set = membersByTier[tier];
      if (!set || set.size === 0) continue;
      const externalId = TIER_EXTERNAL_ID[tier] || `risky-consent:${tier}`;
      contexts.push({
        externalId,
        displayName: `Risky Consent — ${tier}`,
        contextType: 'RiskyConsent',
        description: `Principals holding at least one ${tier.toLowerCase()}-risk OAuth / application consent.`,
        extendedAttributes: { tier },
      });
      for (const principalId of set) members.push({ contextExternalId: externalId, memberId: principalId });
    }

    ctx.log?.(`Risky consent: ${contexts.length} tier context(s), ${members.length} member link(s).`);
    return { contexts, members };
  },
};
