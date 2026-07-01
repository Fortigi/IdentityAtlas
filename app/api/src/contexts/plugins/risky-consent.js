// risky-consent plugin.
//
// Groups the RISKY OAuth *grants themselves* (the DelegatedPermission / AppRole
// resources) into contexts, so you can scope a matrix to them and read off which
// users consented. The context MEMBERS are the grant resources (targetType
// Resource) — not principals — because the matrix already answers "who has this
// resource"; a context of principals would pre-collapse exactly the axis you want
// to explore.
//
// It emits two kinds of grouping in one run:
//   1. By permission risk (curated risk map): "Risky Consent — High" / "— Medium".
//   2. By app reputation:  "Risky App Consent — Malicious" (OAuthSentry threat
//      feed) / "— Suspicious" (self-registered/unverified publisher, or very low
//      consent prevalence). App reputation applies to delegated grants (which
//      carry a client app); application-permission (AppRole) grants only get the
//      permission-risk grouping.
//
// No crawler/schema change: permission strings come from the resources' own
// extendedAttributes; the client appId is reachable via clientSpId → Principal.

import * as db from '../../db/connection.js';
import { classifyPermission } from './riskyConsentRiskMap.js';
import { fetchMaliciousAppIds, DEFAULT_FEED_URL } from './riskyAppFeed.js';

const PERMISSION_EXT = { High: 'risky-consent:High', Medium: 'risky-consent:Medium', Low: 'risky-consent:Low' };
const MALICIOUS_EXT = 'risky-app-consent:Malicious';
const SUSPICIOUS_EXT = 'risky-app-consent:Suspicious';
const UNVERIFIED_PUBLISHERS = new Set(['', 'default directory']);

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'risky-consent',
  displayName: 'Risky Consent',
  description:
    'Groups risky OAuth / application permission grants into contexts you can scope a matrix to — by permission risk ("Risky Consent — High/Medium") and by app reputation ("Risky App Consent — Malicious/Suspicious", using the OAuthSentry threat feed + heuristics). Members are the grants; filter a matrix to a group to see which users consented.',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    properties: {
      scopeSystemId: { type: 'integer', description: 'Restrict to grants in this system. Omit for all systems.' },
      includeAppRoles: { type: 'boolean', description: 'Also classify application permissions (AppRole), not just delegated scopes. Default true.' },
      enabledTiers: {
        type: 'array',
        items: { type: 'string', enum: ['High', 'Medium', 'Low'] },
        description: 'Which permission-risk tiers to emit. Default ["High","Medium"].',
      },
      unknownTier: { type: 'string', enum: ['High', 'Medium', 'Low'], description: 'Tier for unmapped permissions. Default "Low".' },
      includeAppReputation: { type: 'boolean', description: 'Also emit the malicious/suspicious app-reputation groups. Default true.' },
      useThreatFeed: { type: 'boolean', description: 'Fetch the OAuthSentry feed for the malicious group. Default true; falls back to heuristics if unreachable.' },
      feedUrl: { type: 'string', description: 'OAuthSentry malicious-app feed CSV URL. Default the public all_malicious feed.' },
      heuristics: { type: 'boolean', description: 'Flag suspicious apps (unverified publisher / low prevalence). Default true.' },
      lowPrevalenceThreshold: { type: 'integer', description: 'An app consented by at most this many principals is low-prevalence. Default 2.' },
    },
  },

  async run(params, ctx) {
    const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;
    const includeAppRoles = params.includeAppRoles !== false;
    const enabledTiers =
      Array.isArray(params.enabledTiers) && params.enabledTiers.length ? params.enabledTiers : ['High', 'Medium'];
    const unknownTier = params.unknownTier || 'Low';
    const includeAppReputation = params.includeAppReputation !== false;
    const useThreatFeed = params.useThreatFeed !== false;
    const heuristics = params.heuristics !== false;
    const lowPrevalenceThreshold = Number.isInteger(params.lowPrevalenceThreshold) ? params.lowPrevalenceThreshold : 2;
    const feedUrl = params.feedUrl || DEFAULT_FEED_URL;

    const types = includeAppRoles ? ['DelegatedPermission', 'AppRole'] : ['DelegatedPermission'];
    const args = [types];
    let scopeClause = '';
    if (scopeSystemId) {
      args.push(scopeSystemId);
      scopeClause = ` AND r."systemId" = $${args.length}`;
    }

    // One row per risky-candidate GRANT resource, with its permission string and
    // (for delegated grants) the client app's appId + publisher.
    const rows = (await db.query(
      `SELECT r.id AS "resourceId",
              COALESCE(r."extendedAttributes"->>'scope', r."extendedAttributes"->>'appRoleValue') AS "permission",
              lower(p."extendedAttributes"->>'appId') AS "appId",
              p."extendedAttributes"->>'publisherName' AS "publisher"
         FROM "Resources" r
         LEFT JOIN "Principals" p ON p.id::text = r."extendedAttributes"->>'clientSpId'
        WHERE r."resourceType" = ANY($1)
          AND r."deletedAt" IS NULL${scopeClause}`,
      args,
    )).rows;

    if (rows.length === 0) {
      ctx.log?.('No delegated/application grants found — nothing to do.');
      return { contexts: [], members: [] };
    }

    // App-reputation inputs (only when needed).
    let malicious = new Set();
    let prevalence = new Map();
    if (includeAppReputation) {
      if (useThreatFeed) {
        try {
          malicious = await fetchMaliciousAppIds(feedUrl);
          ctx.log?.(`OAuthSentry feed: ${malicious.size} malicious appId(s).`);
        } catch (e) {
          ctx.log?.(`OAuthSentry feed unavailable (${e.message}) — heuristics only.`);
        }
      }
      if (heuristics) prevalence = await appConsentPrevalence(scopeSystemId);
    }

    // externalId → Set(resourceId). A grant can land in several groups (e.g. a
    // High permission AND a malicious app).
    const groups = new Map();
    const add = (externalId, resourceId) => {
      if (!groups.has(externalId)) groups.set(externalId, new Set());
      groups.get(externalId).add(resourceId);
    };

    for (const row of rows) {
      if (!row.resourceId) continue;

      // 1. Permission risk.
      if (row.permission) {
        const tier = classifyPermission(row.permission, { unknownTier });
        if (enabledTiers.includes(tier)) add(PERMISSION_EXT[tier], row.resourceId);
      }

      // 2. App reputation (delegated grants only — AppRole has no client app).
      if (includeAppReputation && row.appId) {
        if (malicious.has(row.appId)) {
          add(MALICIOUS_EXT, row.resourceId);
        } else if (heuristics) {
          const unverified = UNVERIFIED_PUBLISHERS.has((row.publisher || '').trim().toLowerCase());
          const lowPrevalence = (prevalence.get(row.appId) || 0) <= lowPrevalenceThreshold;
          if (unverified || lowPrevalence) add(SUSPICIOUS_EXT, row.resourceId);
        }
      }
    }

    const META = {
      'risky-consent:High':   { displayName: 'Risky Consent — High',   contextType: 'RiskyConsent',    ext: { dimension: 'permission', tier: 'High' } },
      'risky-consent:Medium': { displayName: 'Risky Consent — Medium', contextType: 'RiskyConsent',    ext: { dimension: 'permission', tier: 'Medium' } },
      'risky-consent:Low':    { displayName: 'Risky Consent — Low',    contextType: 'RiskyConsent',    ext: { dimension: 'permission', tier: 'Low' } },
      [MALICIOUS_EXT]:        { displayName: 'Risky App Consent — Malicious',  contextType: 'RiskyAppConsent', ext: { dimension: 'app', severity: 'Malicious', source: 'oauthsentry' } },
      [SUSPICIOUS_EXT]:       { displayName: 'Risky App Consent — Suspicious', contextType: 'RiskyAppConsent', ext: { dimension: 'app', severity: 'Suspicious', source: 'heuristics' } },
    };
    // Stable, readable emit order.
    const ORDER = ['risky-consent:High', 'risky-consent:Medium', 'risky-consent:Low', MALICIOUS_EXT, SUSPICIOUS_EXT];

    const contexts = [];
    const members = [];
    for (const externalId of ORDER) {
      const set = groups.get(externalId);
      if (!set || set.size === 0) continue;
      const meta = META[externalId];
      contexts.push({
        externalId,
        displayName: meta.displayName,
        contextType: meta.contextType,
        description: `Risky OAuth / application grants (${meta.displayName}). Scope a matrix to this group to see who consented.`,
        extendedAttributes: meta.ext,
      });
      for (const resourceId of set) members.push({ contextExternalId: externalId, memberId: resourceId });
    }

    ctx.log?.(`Risky consent: ${contexts.length} grant group(s), ${members.length} grant membership(s).`);
    return { contexts, members };
  },
};

// Distinct consenting principals per client appId (for the low-prevalence heuristic).
async function appConsentPrevalence(scopeSystemId) {
  const args = [];
  let scopeClause = '';
  if (scopeSystemId) {
    args.push(scopeSystemId);
    scopeClause = ` AND ra."systemId" = $${args.length}`;
  }
  const rows = (await db.query(
    `SELECT lower(p."extendedAttributes"->>'appId') AS "appId",
            count(DISTINCT ra."principalId") AS "principals"
       FROM "ResourceAssignments" ra
       JOIN "Resources" r  ON r.id = ra."resourceId" AND r."resourceType" = 'DelegatedPermission'
       JOIN "Principals" p ON p.id::text = r."extendedAttributes"->>'clientSpId'
      WHERE ra."principalId" IS NOT NULL
        AND ra."deletedAt" IS NULL
        AND r."deletedAt" IS NULL
        AND p."extendedAttributes" ? 'appId'${scopeClause}
      GROUP BY 1`,
    args,
  )).rows;
  const map = new Map();
  for (const row of rows) if (row.appId) map.set(row.appId, Number(row.principals));
  return map;
}
