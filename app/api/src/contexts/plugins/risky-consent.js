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

const META = {
  'risky-consent:High':   { displayName: 'Risky Consent — High',   contextType: 'RiskyConsent',    ext: { dimension: 'permission', tier: 'High' } },
  'risky-consent:Medium': { displayName: 'Risky Consent — Medium', contextType: 'RiskyConsent',    ext: { dimension: 'permission', tier: 'Medium' } },
  'risky-consent:Low':    { displayName: 'Risky Consent — Low',    contextType: 'RiskyConsent',    ext: { dimension: 'permission', tier: 'Low' } },
  [MALICIOUS_EXT]:        { displayName: 'Risky App Consent — Malicious',  contextType: 'RiskyAppConsent', ext: { dimension: 'app', severity: 'Malicious', source: 'oauthsentry' } },
  [SUSPICIOUS_EXT]:       { displayName: 'Risky App Consent — Suspicious', contextType: 'RiskyAppConsent', ext: { dimension: 'app', severity: 'Suspicious', source: 'heuristics' } },
};
// Stable, readable emit order.
const ORDER = ['risky-consent:High', 'risky-consent:Medium', 'risky-consent:Low', MALICIOUS_EXT, SUSPICIOUS_EXT];

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
    const cfg = normalizeParams(params);
    const rows = await fetchGrantRows(cfg);
    if (rows.length === 0) {
      ctx.log?.('No delegated/application grants found — nothing to do.');
      return { contexts: [], members: [] };
    }
    const { malicious, prevalence } = await loadAppReputationInputs(cfg, ctx);
    const groups = assignGrantGroups(rows, cfg, malicious, prevalence);
    const { contexts, members } = assembleOutput(groups);
    ctx.log?.(`Risky consent: ${contexts.length} grant group(s), ${members.length} grant membership(s).`);
    return { contexts, members };
  },
};

function normalizeParams(params) {
  return {
    scopeSystemId: params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null,
    includeAppRoles: params.includeAppRoles !== false,
    enabledTiers: Array.isArray(params.enabledTiers) && params.enabledTiers.length ? params.enabledTiers : ['High', 'Medium'],
    unknownTier: params.unknownTier || 'Low',
    includeAppReputation: params.includeAppReputation !== false,
    useThreatFeed: params.useThreatFeed !== false,
    heuristics: params.heuristics !== false,
    lowPrevalenceThreshold: Number.isInteger(params.lowPrevalenceThreshold) ? params.lowPrevalenceThreshold : 2,
    feedUrl: params.feedUrl || DEFAULT_FEED_URL,
  };
}

// One row per risky-candidate GRANT resource, with its permission string and
// (for delegated grants) the client app's appId + publisher.
async function fetchGrantRows(cfg) {
  const types = cfg.includeAppRoles ? ['DelegatedPermission', 'AppRole'] : ['DelegatedPermission'];
  const args = [types];
  let scopeClause = '';
  if (cfg.scopeSystemId) {
    args.push(cfg.scopeSystemId);
    scopeClause = ` AND r."systemId" = $${args.length}`;
  }
  return (await db.query(
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
}

// Feed (best-effort) + per-app consent prevalence, only when app reputation is on.
async function loadAppReputationInputs(cfg, ctx) {
  let malicious = new Set();
  let prevalence = new Map();
  if (!cfg.includeAppReputation) return { malicious, prevalence };
  if (cfg.useThreatFeed) {
    try {
      malicious = await fetchMaliciousAppIds(cfg.feedUrl);
      ctx.log?.(`OAuthSentry feed: ${malicious.size} malicious appId(s).`);
    } catch (e) {
      ctx.log?.(`OAuthSentry feed unavailable (${e.message}) — heuristics only.`);
    }
  }
  if (cfg.heuristics) prevalence = await appConsentPrevalence(cfg.scopeSystemId);
  return { malicious, prevalence };
}

// externalId → Set(resourceId). A grant can land in several groups (e.g. a High
// permission AND a malicious app).
function assignGrantGroups(rows, cfg, malicious, prevalence) {
  const groups = new Map();
  const add = (externalId, resourceId) => {
    if (!groups.has(externalId)) groups.set(externalId, new Set());
    groups.get(externalId).add(resourceId);
  };
  for (const row of rows) {
    if (!row.resourceId) continue;
    addPermissionGroup(add, row, cfg);
    addAppReputationGroup(add, row, cfg, malicious, prevalence);
  }
  return groups;
}

function addPermissionGroup(add, row, cfg) {
  if (!row.permission) return;
  const tier = classifyPermission(row.permission, { unknownTier: cfg.unknownTier });
  if (cfg.enabledTiers.includes(tier)) add(PERMISSION_EXT[tier], row.resourceId);
}

// Delegated grants only — AppRole grants have no client app (row.appId is null).
function addAppReputationGroup(add, row, cfg, malicious, prevalence) {
  if (!cfg.includeAppReputation || !row.appId) return;
  if (malicious.has(row.appId)) {
    add(MALICIOUS_EXT, row.resourceId);
    return; // a malicious app outranks the suspicious heuristics for this grant
  }
  if (!cfg.heuristics) return;
  const unverified = UNVERIFIED_PUBLISHERS.has((row.publisher || '').trim().toLowerCase());
  const lowPrevalence = (prevalence.get(row.appId) || 0) <= cfg.lowPrevalenceThreshold;
  if (unverified || lowPrevalence) add(SUSPICIOUS_EXT, row.resourceId);
}

function assembleOutput(groups) {
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
  return { contexts, members };
}

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
