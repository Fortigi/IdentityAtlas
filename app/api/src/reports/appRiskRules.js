// The application risk score: a fixed set of rules, each turning one fact
// about an app into a finding worth a number of points, and a sum.
//
// Deliberately a sum of named, explained findings rather than a model: every
// point on a row can be traced to one sentence a reviewer can check against
// Entra. Weights live in one table (POINTS) so they are argued about in one
// place. A known-malicious appId overrides everything (Critical, 100).
//
// Rules read a fact object (see appRiskData.js / buildAppFacts) and a context
// { now, maliciousAppIds, inactiveDays }. Facts that were not collected are
// null, and a rule that needs them stays silent rather than guessing: "no
// owners" is only said when owners were crawled.

import { atLeast, highestTier } from './appRiskPermissions.js';

export const POINTS = Object.freeze({
  knownMalicious: 100,
  impersonation: 25,
  unverifiedThirdParty: 10,
  appOnly: { Critical: 40, High: 25, Medium: 10 },
  appOnlyBreadthEach: 3,
  appOnlyBreadthMax: 10,
  adminConsent: { Critical: 20, High: 20, Medium: 8 },
  userConsent: { Critical: 10, High: 10, Medium: 4 },
  userConsentManyUsers: 5,
  publicClient: 10,
  publicClientWithReach: 5,
  implicitAccessTokens: 5,
  wildcardRedirect: 10,
  insecureRedirect: 10,
  multiTenantOwnApp: 5,
  secretNeverExpires: 20,
  secretLongLived: 10,
  secretOnServicePrincipal: 20,
  expiredCredentials: 3,
  manyActiveSecrets: 5,
  broadFederatedCredential: 10,
  ownerGone: 10,
  guestOwner: 10,
  ownerCanActAsApp: 15,
  noOwner: 5,
  unusedButPowerful: 10,
  newAndPowerful: 10,
});

export const LEVELS = Object.freeze([
  { level: 'Critical', min: 60 },
  { level: 'High', min: 35 },
  { level: 'Medium', min: 15 },
  { level: 'Low', min: 1 },
  { level: 'None', min: 0 },
]);

const DAY = 24 * 60 * 60 * 1000;
const NEVER_EXPIRES_DAYS = 3650;   // ten years: nobody rotates that
const LONG_LIVED_DAYS = 730;       // Microsoft's own maximum recommendation is two years
const NEW_APP_DAYS = 30;
const MANY_USERS = 10;
const MULTI_TENANT = new Set(['AzureADMultipleOrgs', 'AzureADandPersonalMicrosoftAccount', 'PersonalMicrosoftAccount']);
// Names an attacker borrows to look like a Microsoft first-party app.
const MICROSOFT_LOOKALIKE = /\b(microsoft|office ?365|o365|m365|outlook|onedrive|sharepoint|teams|azure|exchange|entra)\b/i;

const finding = (id, category, points, text) => ({ id, category, points, text });
const top = (list, n = 3) => list.slice(0, n).join(', ') + (list.length > n ? `, +${list.length - n} more` : '');

/** The highest tier the app reaches with app-only permissions. */
export function appOnlyTier(app) {
  return highestTier((app.appPermissions ?? []).map(p => p.tier));
}

/** The highest tier the app reaches at all (app-only or delegated). */
export function reachTier(app) {
  return highestTier([...(app.appPermissions ?? []), ...(app.delegated ?? [])].map(p => p.tier));
}

// ─── Reputation ────────────────────────────────────────────────────────────

function knownMalicious(app, ctx) {
  if (!ctx.maliciousAppIds?.has(String(app.appId ?? '').toLowerCase())) return null;
  return finding('knownMalicious', 'Reputation', POINTS.knownMalicious,
    'Its appId is on the OAuthSentry list of apps seen in consent-phishing and mailbox-takeover campaigns');
}

function impersonation(app) {
  if (app.ownerTenant !== 'Third party' || !MICROSOFT_LOOKALIKE.test(app.displayName ?? '')) return null;
  return finding('impersonation', 'Reputation', POINTS.impersonation,
    `Named like a Microsoft app ("${app.displayName}") but registered in another organisation's tenant`);
}

function unverifiedThirdParty(app) {
  if (app.ownerTenant !== 'Third party' || app.sp?.verifiedPublisherName) return null;
  if (!atLeast(reachTier(app), 'Medium')) return null;
  return finding('unverifiedThirdParty', 'Reputation', POINTS.unverifiedThirdParty,
    `Third-party app without a verified publisher${app.sp?.publisherName ? ` (says "${app.sp.publisherName}")` : ''}`);
}

// ─── What it can reach ─────────────────────────────────────────────────────

function appOnlyReach(app) {
  const tier = appOnlyTier(app);
  const points = POINTS.appOnly[tier];
  if (!points) return null;
  const names = app.appPermissions.filter(p => p.tier === tier).map(p => p.permission).sort();
  return finding('appOnlyReach', 'Permissions', points,
    `Holds ${tier.toLowerCase()}-risk application permissions with nobody signed in: ${top(names)}`);
}

function appOnlyBreadth(app) {
  const strong = (app.appPermissions ?? []).filter(p => atLeast(p.tier, 'High'));
  if (strong.length < 2) return null;
  const points = Math.min(POINTS.appOnlyBreadthMax, (strong.length - 1) * POINTS.appOnlyBreadthEach);
  return finding('appOnlyBreadth', 'Permissions', points, `${strong.length} high-risk application permissions in total`);
}

function adminConsent(app) {
  const consented = (app.delegated ?? []).filter(d => d.adminConsented);
  const tier = highestTier(consented.map(d => d.tier));
  const points = POINTS.adminConsent[tier];
  if (!points) return null;
  const names = consented.filter(d => d.tier === tier).map(d => d.scope).sort();
  return finding('adminConsent', 'Consent', points,
    `An administrator consented on behalf of every user to ${top(names)}`);
}

function userConsent(app) {
  const consented = (app.delegated ?? []).filter(d => d.userCount > 0);
  const tier = highestTier(consented.map(d => d.tier));
  const base = POINTS.userConsent[tier];
  if (!base) return null;
  const users = Math.max(...consented.filter(d => d.tier === tier).map(d => d.userCount));
  const names = consented.filter(d => d.tier === tier).map(d => d.scope).sort();
  const points = base + (users >= MANY_USERS ? POINTS.userConsentManyUsers : 0);
  return finding('userConsent', 'Consent', points, `${users} user(s) personally consented to ${top(names)}`);
}

// ─── How it is set up ──────────────────────────────────────────────────────

function publicClient(app) {
  if (app.reg?.isFallbackPublicClient !== true) return null;
  const withReach = atLeast(highestTier((app.delegated ?? []).map(d => d.tier)), 'High');
  return finding('publicClient', 'Configuration', POINTS.publicClient + (withReach ? POINTS.publicClientWithReach : 0),
    'Public-client flows are allowed: anyone can try a username and password against it (ROPC, password spraying) or use device-code sign-in'
    + (withReach ? ', and it holds high-risk delegated permissions' : ''));
}

function implicitAccessTokens(app) {
  if (app.reg?.implicitGrantAccessTokens !== true) return null;
  return finding('implicitAccessTokens', 'Configuration', POINTS.implicitAccessTokens,
    'Implicit grant issues access tokens in the browser URL');
}

/** Every redirect / reply URI the app accepts, from both objects. */
export function redirectUris(app) {
  const lists = [app.reg?.webRedirectUris, app.reg?.spaRedirectUris, app.reg?.publicClientRedirectUris, app.sp?.replyUrls];
  return [...new Set(lists.filter(Boolean).flatMap(s => String(s).split(',')).map(u => u.trim()).filter(Boolean))];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for an http:// URI that leaves the machine (loopback http is how native apps receive tokens). */
export function isInsecureRedirect(uri) {
  let url;
  try { url = new URL(uri); } catch { return false; }
  return url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname);
}

function wildcardRedirect(app) {
  const hits = redirectUris(app).filter(u => u.includes('*'));
  if (hits.length === 0) return null;
  return finding('wildcardRedirect', 'Configuration', POINTS.wildcardRedirect,
    `Wildcard redirect URI lets tokens go to hosts nobody listed: ${top(hits)}`);
}

function insecureRedirect(app) {
  const hits = redirectUris(app).filter(isInsecureRedirect);
  if (hits.length === 0) return null;
  return finding('insecureRedirect', 'Configuration', POINTS.insecureRedirect,
    `Unencrypted (http) redirect URI: ${top(hits)}`);
}

function multiTenantOwnApp(app) {
  if (app.ownerTenant !== 'This tenant' || !MULTI_TENANT.has(app.reg?.signInAudience)) return null;
  return finding('multiTenantOwnApp', 'Configuration', POINTS.multiTenantOwnApp,
    'One of your own apps that accounts from any organisation can sign in to');
}

// ─── Credentials ───────────────────────────────────────────────────────────

function longLivedSecret(app) {
  const days = Math.max(app.reg?.secretMaxValidityDays ?? 0, app.sp?.secretMaxValidityDays ?? 0);
  if (days > NEVER_EXPIRES_DAYS) {
    return finding('longLivedSecret', 'Credentials', POINTS.secretNeverExpires,
      `A client secret is valid for ${Math.round(days / 365)} years — in practice it never expires`);
  }
  if (days > LONG_LIVED_DAYS) {
    return finding('longLivedSecret', 'Credentials', POINTS.secretLongLived,
      `A client secret is valid for ${Math.round(days / 365 * 10) / 10} years (more than two)`);
  }
  return null;
}

function secretOnServicePrincipal(app) {
  if (app.principalType === 'ManagedIdentity' || !(app.sp?.secretCount > 0)) return null;
  return finding('secretOnServicePrincipal', 'Credentials', POINTS.secretOnServicePrincipal,
    `${app.sp.secretCount} client secret(s) sit on the enterprise application itself, where the App registrations page does not show them`);
}

const credentialsOf = app => [...(app.reg?.credentials ?? []), ...(app.sp?.credentials ?? [])];
const endsBefore = (c, now) => c.endDateTime && new Date(c.endDateTime).getTime() < now.getTime();

function expiredCredentials(app, ctx) {
  const expired = credentialsOf(app).filter(c => endsBefore(c, ctx.now));
  if (expired.length === 0) return null;
  return finding('expiredCredentials', 'Credentials', POINTS.expiredCredentials,
    `${expired.length} expired credential(s) never cleaned up`);
}

function manyActiveSecrets(app, ctx) {
  const active = credentialsOf(app).filter(c => c.type === 'Secret' && !endsBefore(c, ctx.now));
  if (active.length < 3) return null;
  return finding('manyActiveSecrets', 'Credentials', POINTS.manyActiveSecrets,
    `${active.length} client secrets are valid at the same time`);
}

function broadFederatedCredential(app) {
  const broad = (app.reg?.federatedCredentials ?? []).filter(f => f.claimsMatchingExpression || String(f.subject ?? '').includes('*'));
  if (broad.length === 0) return null;
  return finding('broadFederatedCredential', 'Credentials', POINTS.broadFederatedCredential,
    `Federated credential matches a pattern rather than one workload: ${top(broad.map(f => f.name))}`);
}

// ─── Ownership ─────────────────────────────────────────────────────────────

const liveUserOwners = app => (app.owners ?? []).filter(o => o.principalType === 'User' && !o.deleted && o.accountEnabled !== false);

function ownerGone(app) {
  const gone = (app.owners ?? []).filter(o => o.deleted || o.accountEnabled === false);
  if (gone.length === 0) return null;
  return finding('ownerGone', 'Ownership', POINTS.ownerGone,
    `${gone.length} owner(s) are disabled or deleted — nobody may be looking after it`);
}

function guestOwner(app) {
  const guests = (app.owners ?? []).filter(o => o.guest && !o.deleted);
  if (guests.length === 0) return null;
  return finding('guestOwner', 'Ownership', POINTS.guestOwner,
    `${guests.length} guest account(s) own it and can add a credential to it`);
}

function ownerCanActAsApp(app) {
  const owners = liveUserOwners(app);
  if (owners.length === 0 || !atLeast(appOnlyTier(app), 'Critical')) return null;
  return finding('ownerCanActAsApp', 'Ownership', POINTS.ownerCanActAsApp,
    `${owners.length} user owner(s) can add a secret and act as an app with critical permissions — a path to those permissions without holding them`);
}

function noOwner(app) {
  if (app.owners === null || app.owners === undefined || app.owners.length > 0) return null;
  if (app.ownerTenant !== 'This tenant' || !atLeast(reachTier(app), 'High')) return null;
  return finding('noOwner', 'Ownership', POINTS.noOwner, 'Nobody owns this app, yet it holds high-risk permissions');
}

// ─── Activity ──────────────────────────────────────────────────────────────

function unusedButPowerful(app, ctx) {
  if (!app.activityKnown || !atLeast(reachTier(app), 'High')) return null;
  const last = app.lastSignIn ? new Date(app.lastSignIn) : null;
  if (last && ctx.now.getTime() - last.getTime() < ctx.inactiveDays * DAY) return null;
  return finding('unusedButPowerful', 'Activity', POINTS.unusedButPowerful,
    last ? `No sign-in for ${Math.floor((ctx.now.getTime() - last.getTime()) / DAY)} days, yet it keeps high-risk permissions`
      : 'Never signed in, yet it holds high-risk permissions');
}

function newAndPowerful(app, ctx) {
  const created = app.createdDateTime ? new Date(app.createdDateTime) : null;
  if (!created || ctx.now.getTime() - created.getTime() > NEW_APP_DAYS * DAY) return null;
  if (!atLeast(appOnlyTier(app), 'Critical')) return null;
  return finding('newAndPowerful', 'Activity', POINTS.newAndPowerful,
    'Created in the last 30 days and already holds critical application permissions');
}

export const RULES = Object.freeze([
  knownMalicious, impersonation, unverifiedThirdParty,
  appOnlyReach, appOnlyBreadth, adminConsent, userConsent,
  publicClient, implicitAccessTokens, wildcardRedirect, insecureRedirect, multiTenantOwnApp,
  longLivedSecret, secretOnServicePrincipal, expiredCredentials, manyActiveSecrets, broadFederatedCredential,
  ownerGone, guestOwner, ownerCanActAsApp, noOwner,
  unusedButPowerful, newAndPowerful,
]);

/** The level a score falls in. */
export function levelFor(score) {
  return LEVELS.find(l => score >= l.min).level;
}

/**
 * Score one app.
 * @returns {{ score: number, level: string, findings: Array<{id, category, points, text}> }}
 *   findings sorted by points, highest first. A disabled app keeps its findings
 *   but half its score: it cannot sign in until someone re-enables it.
 */
export function scoreApp(app, ctx) {
  const findings = RULES.map(rule => rule(app, ctx)).filter(Boolean).sort((a, b) => b.points - a.points);
  const malicious = findings.some(f => f.id === 'knownMalicious');
  let score = Math.min(100, findings.reduce((s, f) => s + f.points, 0));
  if (app.accountEnabled === false && !malicious && score > 0) {
    const off = Math.ceil(score / 2);
    findings.push(finding('disabled', 'Activity', -off, 'Disabled: it cannot sign in until someone re-enables it'));
    score -= off;
  }
  return { score, level: malicious ? 'Critical' : levelFor(score), findings };
}
