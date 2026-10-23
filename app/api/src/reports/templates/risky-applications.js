// Risky Applications (Entra ID) — one row per enterprise application, managed
// identity or AI agent, with a 0–100 score and the reasons behind it.
//
// Where High-risk Application Permissions lists grants, this report judges the
// app as a whole: what it can reach (app-only permissions, admin and user
// consent), how it is set up (public-client flows, redirect URIs), its
// credentials (secrets that never expire, secrets hidden on the enterprise
// app), who owns it, whether it is used, and whether its appId is on a public
// list of malicious apps. The rules and their weights are in
// reports/appRiskRules.js; every point on a row comes from a named finding.

import { buildAppFacts, loadAppRiskRows } from '../appRiskData.js';
import { LEVELS, scoreApp, appOnlyTier, reachTier } from '../appRiskRules.js';
import { DEFAULT_FEED_URL, fetchMaliciousAppIds } from '../../contexts/plugins/riskyAppFeed.js';
import { parseDays } from '../activityWindow.js';

const DEFAULT_INACTIVE_DAYS = 90;
const SELECTABLE_LEVELS = LEVELS.filter(l => l.level !== 'None').map(l => l.level);
const MAX_REASONS = 3;

/** The run's choices from its raw parameters, whatever form they arrived in. */
export function parseOptions(params = {}) {
  const bool = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : !(v === false || String(v).toLowerCase() === 'false'));
  return {
    minimumLevel: SELECTABLE_LEVELS.includes(params.minimumLevel) ? params.minimumLevel : 'Medium',
    includeMicrosoft: bool(params.includeMicrosoft, false),
    useThreatFeed: bool(params.useThreatFeed, true),
    inactiveDays: parseDays(params.inactiveDays, DEFAULT_INACTIVE_DAYS),
  };
}

const levelRank = level => LEVELS.findIndex(l => l.level === level);

/** One report row from an app's facts and its score. */
export function toRow(app, result) {
  const sp = app.sp ?? {};
  const secretDays = Math.max(app.reg?.secretMaxValidityDays ?? 0, sp.secretMaxValidityDays ?? 0);
  return {
    application: app.displayName,
    appId: app.appId,
    holderType: app.principalType,
    registeredIn: app.ownerTenant,
    publisher: sp.verifiedPublisherName ? `${sp.verifiedPublisherName} (verified)` : (sp.publisherName ?? null),
    score: result.score,
    level: result.level,
    reasons: result.findings.filter(f => f.points > 0).slice(0, MAX_REASONS).map(f => f.text).join(' · '),
    findings: result.findings.map(f => `${f.category}: ${f.text} (${f.points > 0 ? '+' : ''}${f.points})`).join('\n'),
    reach: reachTier(app),
    appOnlyReach: appOnlyTier(app),
    applicationPermissions: (app.appPermissions ?? []).length,
    adminConsentedScopes: (app.delegated ?? []).filter(d => d.adminConsented).length,
    consentingUsers: Math.max(0, ...(app.delegated ?? []).map(d => d.userCount)),
    secrets: (app.reg?.secretCount ?? 0) + (sp.secretCount ?? 0),
    longestSecretYears: secretDays > 0 ? Math.round(secretDays / 365 * 10) / 10 : null,
    publicClientFlows: app.reg ? app.reg.isFallbackPublicClient === true : null,
    owners: app.owners ? app.owners.length : null,
    lastSignIn: app.lastSignIn ? new Date(app.lastSignIn).toISOString() : null,
    enabled: app.accountEnabled !== false,
    _entity: { kind: 'resource', id: app.id },
  };
}

/** What the rows could not see, so an empty or low score is read correctly. */
export function coverageNotices({ apps, rows, feedError, useThreatFeed }) {
  const notices = [];
  if (apps.length === 0) {
    notices.push({ severity: 'warning', text: 'No service principals are loaded, so there are no apps to judge. '
      + 'Enable "Service Principals" on the Entra ID crawler and run a full sync.' });
    return notices;
  }
  if (!apps.some(a => a.reg)) {
    notices.push({ severity: 'info', text: 'No app registrations are loaded, so public-client flows, redirect URIs, '
      + 'implicit grant, federated credentials and app-registration secrets are not checked. '
      + 'Enable "App Registrations & Credentials" on the Entra ID crawler.' });
  }
  if (apps.every(a => a.owners === null)) {
    notices.push({ severity: 'info', text: 'App owners are not loaded, so departed, guest and missing owners are not checked. Enable "App Owners".' });
  }
  if (!apps.some(a => a.activityKnown)) {
    notices.push({ severity: 'info', text: 'No service-principal sign-in activity is loaded, so unused apps are not recognised.' });
  }
  if (!useThreatFeed) {
    notices.push({ severity: 'info', text: 'The public list of malicious apps was not consulted (switched off for this run).' });
  } else if (feedError) {
    notices.push({ severity: 'warning', text: `The public list of malicious apps (OAuthSentry) could not be read: ${feedError}. `
      + 'Known-bad apps are therefore not flagged in this run.' });
  }
  notices.push({ severity: 'info', text: `${rows.length} of ${apps.length} apps scored at or above the chosen level. `
    + 'Scores add up fixed points per finding (see the Findings column); a disabled app counts half.' });
  return notices;
}

async function loadThreatFeed(useThreatFeed) {
  if (!useThreatFeed) return { ids: null, error: null };
  try {
    return { ids: await fetchMaliciousAppIds(DEFAULT_FEED_URL), error: null };
  } catch (err) {
    return { ids: null, error: err.message };
  }
}

export default {
  name: 'risky-applications',
  displayName: 'Risky Applications (Entra ID)',
  description:
    'Every enterprise application, managed identity and AI agent scored 0–100 on what it can reach, '
    + 'how it is set up, its credentials, its owners, whether it is used, and whether it appears on a '
    + 'public list of malicious apps — one row per app, with the findings behind the score.',
  form: 'list',
  parametersSchema: {
    type: 'object',
    required: [],
    properties: {
      minimumLevel: {
        type: 'string', title: 'Show apps from level', enum: SELECTABLE_LEVELS, default: 'Medium',
        description: 'Leave out apps that score below this level.',
      },
      includeMicrosoft: {
        type: 'boolean', title: 'Include Microsoft first-party apps', default: false,
        description: 'Microsoft\'s own apps hold broad permissions by design; they are left out unless you switch this on.',
      },
      useThreatFeed: {
        type: 'boolean', title: 'Check the public malicious-app list', default: true,
        description: 'Look up each appId in the OAuthSentry list of apps seen in phishing and mailbox-takeover campaigns. Needs internet access.',
      },
      inactiveDays: {
        type: 'integer', title: 'Days without sign-in', default: DEFAULT_INACTIVE_DAYS,
        description: 'An app with high-risk permissions that has not signed in for this long counts as unused.',
      },
    },
  },
  columns: [
    { key: 'application', label: 'Application' },
    { key: 'score', label: 'Score' },
    { key: 'level', label: 'Level' },
    { key: 'reasons', label: 'Main reasons' },
    { key: 'registeredIn', label: 'Registered in' },
    { key: 'publisher', label: 'Publisher' },
    { key: 'holderType', label: 'Type' },
    { key: 'reach', label: 'Highest permission' },
    { key: 'appOnlyReach', label: 'Highest app-only permission' },
    { key: 'applicationPermissions', label: 'App-only permissions' },
    { key: 'adminConsentedScopes', label: 'Admin-consented scopes' },
    { key: 'consentingUsers', label: 'Consenting users' },
    { key: 'secrets', label: 'Secrets' },
    { key: 'longestSecretYears', label: 'Longest secret (years)' },
    { key: 'publicClientFlows', label: 'Public-client flows' },
    { key: 'owners', label: 'Owners' },
    { key: 'lastSignIn', label: 'Last sign-in' },
    { key: 'enabled', label: 'Enabled' },
    { key: 'appId', label: 'App ID' },
    { key: 'findings', label: 'Findings' },
  ],

  async run(params, ctx) {
    const opts = parseOptions(params);
    const [rawRows, feed] = await Promise.all([loadAppRiskRows(), loadThreatFeed(opts.useThreatFeed)]);
    const apps = buildAppFacts(rawRows).filter(a => opts.includeMicrosoft || a.ownerTenant !== 'Microsoft');
    const scoreCtx = { now: new Date(), maliciousAppIds: feed.ids, inactiveDays: opts.inactiveDays };

    const floor = levelRank(opts.minimumLevel);
    const rows = apps
      .map(app => toRow(app, scoreApp(app, scoreCtx)))
      .filter(row => levelRank(row.level) <= floor)
      .sort((a, b) => (b.score - a.score) || String(a.application ?? '').localeCompare(String(b.application ?? '')));

    ctx?.log?.(`risky-applications report: ${rows.length} of ${apps.length} app(s) at ${opts.minimumLevel} or above`);
    return { rows, notices: coverageNotices({ apps, rows, feedError: feed.error, useThreatFeed: opts.useThreatFeed }) };
  },
};
