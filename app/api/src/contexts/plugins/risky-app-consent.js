// risky-app-consent plugin (Risky Consent — Phase 2).
//
// Where risky-consent classifies the *permission*, this classifies the *app* a
// principal consented to. A DelegatedPermission resource carries the client app's
// service principal (clientSpId); that SP carries the app's appId + publisherName.
// We flag principals who consented to:
//   - a KNOWN-MALICIOUS app — appId in the OAuthSentry threat feed; or
//   - a SUSPICIOUS app (heuristics) — self-registered / unverified publisher
//     ("Default Directory" / empty), or very low consent prevalence (an app only
//     1–2 people consented to is the classic targeted-consent-phishing signal).
//
// The feed (MIT, no auth) is fetched at run time and is best-effort: if it can't
// be reached, the plugin still runs the heuristics. No crawler/schema change — the
// appId join uses data the Entra crawler already stores.

import * as db from '../../db/connection.js';
import { fetchMaliciousAppIds, DEFAULT_FEED_URL } from './riskyAppFeed.js';

const MALICIOUS_EXT = 'risky-app-consent:Malicious';
const SUSPICIOUS_EXT = 'risky-app-consent:Suspicious';
// publisherName values that mean "self-registered in this tenant / not a verified publisher".
const UNVERIFIED_PUBLISHERS = new Set(['', 'default directory']);

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'risky-app-consent',
  displayName: 'Risky App Consent',
  description:
    'Flags principals who consented to a known-malicious OAuth app (OAuthSentry threat feed) or a suspicious one (self-registered / unverified publisher, or very low consent prevalence). Build a matrix on these to find risky third-party app consent.',
  targetType: 'Principal',
  parametersSchema: {
    type: 'object',
    properties: {
      scopeSystemId: {
        type: 'integer',
        description: 'Restrict to consents in this system. Omit to include all systems.',
      },
      useThreatFeed: {
        type: 'boolean',
        description: 'Fetch the OAuthSentry feed to flag known-malicious apps. Default true. Falls back to heuristics if unreachable.',
      },
      feedUrl: {
        type: 'string',
        description: 'OAuthSentry malicious-app feed CSV URL. Default the public all_malicious feed.',
      },
      heuristics: {
        type: 'boolean',
        description: 'Also flag suspicious apps (unverified publisher / low consent prevalence). Default true.',
      },
      lowPrevalenceThreshold: {
        type: 'integer',
        description: 'An app consented by at most this many principals counts as low-prevalence. Default 2.',
      },
    },
  },

  async run(params, ctx) {
    const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;
    const useThreatFeed = params.useThreatFeed !== false;
    const heuristics = params.heuristics !== false;
    const lowPrevalenceThreshold = Number.isInteger(params.lowPrevalenceThreshold) ? params.lowPrevalenceThreshold : 2;
    const feedUrl = params.feedUrl || DEFAULT_FEED_URL;

    const args = [];
    let scopeClause = '';
    if (scopeSystemId) {
      args.push(scopeSystemId);
      scopeClause = ` AND ra."systemId" = $${args.length}`;
    }

    // (consenting principal, client app's appId + publisher) for each delegated consent.
    const rows = (await db.query(
      `SELECT DISTINCT ra."principalId" AS "principalId",
              lower(p."extendedAttributes"->>'appId') AS "appId",
              p."extendedAttributes"->>'publisherName' AS "publisher"
         FROM "ResourceAssignments" ra
         JOIN "Resources" r  ON r.id = ra."resourceId" AND r."resourceType" = 'DelegatedPermission'
         JOIN "Principals" p ON p.id::text = r."extendedAttributes"->>'clientSpId'
        WHERE ra."principalId" IS NOT NULL
          AND ra."deletedAt" IS NULL
          AND r."deletedAt" IS NULL
          AND p."extendedAttributes" ? 'appId'${scopeClause}`,
      args,
    )).rows;

    if (rows.length === 0) {
      ctx.log?.('No delegated app consents with an appId — nothing to do.');
      return { contexts: [], members: [] };
    }

    // Prevalence: distinct principals per appId (for the low-prevalence heuristic).
    const prevalence = new Map();
    for (const row of rows) {
      if (!row.appId) continue;
      if (!prevalence.has(row.appId)) prevalence.set(row.appId, new Set());
      prevalence.get(row.appId).add(row.principalId);
    }

    // Malicious feed — best-effort; heuristics still run if it's unreachable.
    let malicious = new Set();
    if (useThreatFeed) {
      try {
        malicious = await fetchMaliciousAppIds(feedUrl);
        ctx.log?.(`OAuthSentry feed: ${malicious.size} malicious appId(s).`);
      } catch (e) {
        ctx.log?.(`OAuthSentry feed unavailable (${e.message}) — running heuristics only.`);
      }
    }

    const maliciousMembers = new Set();
    const suspiciousMembers = new Set();
    for (const row of rows) {
      if (!row.appId || !row.principalId) continue;
      if (malicious.has(row.appId)) {
        maliciousMembers.add(row.principalId);
        continue; // a malicious app outranks the suspicious heuristics for this consent
      }
      if (heuristics) {
        const unverified = UNVERIFIED_PUBLISHERS.has((row.publisher || '').trim().toLowerCase());
        const lowPrevalence = (prevalence.get(row.appId)?.size || 0) <= lowPrevalenceThreshold;
        if (unverified || lowPrevalence) suspiciousMembers.add(row.principalId);
      }
    }

    const contexts = [];
    const members = [];
    if (maliciousMembers.size > 0) {
      contexts.push({
        externalId: MALICIOUS_EXT,
        displayName: 'Risky App Consent — Malicious',
        contextType: 'RiskyAppConsent',
        description: 'Principals who consented to an app flagged malicious by the OAuthSentry threat feed.',
        extendedAttributes: { severity: 'Malicious', source: 'oauthsentry' },
      });
      for (const pid of maliciousMembers) members.push({ contextExternalId: MALICIOUS_EXT, memberId: pid });
    }
    if (suspiciousMembers.size > 0) {
      contexts.push({
        externalId: SUSPICIOUS_EXT,
        displayName: 'Risky App Consent — Suspicious',
        contextType: 'RiskyAppConsent',
        description: 'Principals who consented to a suspicious app (self-registered / unverified publisher, or very low consent prevalence).',
        extendedAttributes: { severity: 'Suspicious', source: 'heuristics' },
      });
      for (const pid of suspiciousMembers) members.push({ contextExternalId: SUSPICIOUS_EXT, memberId: pid });
    }

    ctx.log?.(`Risky app consent: ${maliciousMembers.size} malicious-app member(s), ${suspiciousMembers.size} suspicious.`);
    return { contexts, members };
  },
};
