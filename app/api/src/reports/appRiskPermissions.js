// One answer to "how dangerous is this permission?" for the application risk
// score, built from the two lists that already exist instead of a third one:
//
// - appPermissionRisk.js — the explicit shortlist of APP-ONLY permissions,
//   keyed by the API's appId, with a Critical/High severity. It is the only
//   list that knows an app-only Mail.Read reads every mailbox, so it wins for
//   application permissions.
// - riskyConsentRiskMap.js — the name-based High/Medium/Low tiering (with a
//   pattern fallback for the long tail) the risky-consent context plugin uses.
//   It covers delegated scopes and the app-only permissions the shortlist does
//   not name.
//
// A name only means something on an API we recognise: any API can publish a
// role called `Mail.Read`. So the name tiering is applied only to Microsoft's
// own APIs, matched by appId; a permission on anything else is 'Unknown'.

import { classifyAppPermission } from './appPermissionRisk.js';
import { classifyPermission } from '../contexts/plugins/riskyConsentRiskMap.js';

// Microsoft APIs whose permission names the tiering understands (appIds are the
// same in every tenant).
export const MICROSOFT_API_APP_IDS = new Set([
  '00000003-0000-0000-c000-000000000000', // Microsoft Graph
  '00000003-0000-0ff1-ce00-000000000000', // Office 365 SharePoint Online
  '00000002-0000-0ff1-ce00-000000000000', // Office 365 Exchange Online
  '00000002-0000-0000-c000-000000000000', // Azure Active Directory Graph (retired)
]);

// Highest first. 'Unknown' ranks below 'Low' so it never outweighs a real tier.
export const PERMISSION_TIERS = Object.freeze(['Critical', 'High', 'Medium', 'Low', 'Unknown']);

/**
 * The risk tier of one permission an app holds.
 * @param {{ kind: 'application'|'delegated', apiAppId?: string|null, permission?: string|null }} p
 * @returns {'Critical'|'High'|'Medium'|'Low'|'Unknown'}
 */
export function permissionTier({ kind, apiAppId, permission }) {
  if (!permission) return 'Unknown';
  if (kind === 'application') {
    const explicit = classifyAppPermission({ targetApiAppId: apiAppId, permission });
    if (explicit) return explicit.severity;
  }
  if (!MICROSOFT_API_APP_IDS.has(String(apiAppId ?? '').toLowerCase())) return 'Unknown';
  return classifyPermission(permission);
}

/** The highest of a set of tiers ('Unknown' when there are none). */
export function highestTier(tiers) {
  let best = PERMISSION_TIERS.length - 1;
  for (const t of tiers) {
    const i = PERMISSION_TIERS.indexOf(t);
    if (i >= 0 && i < best) best = i;
  }
  return PERMISSION_TIERS[best];
}

/** True when `tier` is at least `floor` (e.g. atLeast('Critical', 'High')). */
export function atLeast(tier, floor) {
  const i = PERMISSION_TIERS.indexOf(tier);
  return i >= 0 && i <= PERMISSION_TIERS.indexOf(floor);
}
