// The risky-applications rules. Each rule is tested on both sides of its line
// (just inside, just outside), because a rule that fires on everything and a
// rule that never fires both pass a test that only checks the happy case.

import { describe, it, expect } from 'vitest';
import { scoreApp, levelFor, redirectUris, isInsecureRedirect, reachTier, appOnlyTier, POINTS, RULES } from './appRiskRules.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString();
const ctx = (over = {}) => ({ now: NOW, maliciousAppIds: null, inactiveDays: 90, ...over });

// A quiet app: no finding fires on it.
const app = (over = {}) => ({
  id: 'sp-1', displayName: 'Payroll Connector', appId: 'APP-1', principalType: 'ServicePrincipal',
  accountEnabled: true, createdDateTime: daysAgo(400), ownerTenant: 'This tenant',
  sp: {}, reg: null, appPermissions: [], delegated: [], owners: null, activityKnown: false, lastSignIn: null,
  ...over,
});
const perm = (permission, tier) => ({ permission, tier, apiAppId: 'graph' });
const scope = (s, tier, over = {}) => ({ scope: s, tier, adminConsented: false, userCount: 0, ...over });
const ids = result => result.findings.map(f => f.id);
const pointsOf = (result, id) => result.findings.find(f => f.id === id)?.points;

describe('a quiet app', () => {
  it('scores 0 / None with no findings', () => {
    const r = scoreApp(app(), ctx());
    expect(r).toEqual({ score: 0, level: 'None', findings: [] });
  });
});

describe('reputation', () => {
  it('flags an appId on the malicious list as Critical 100, case-insensitively, even when disabled', () => {
    const r = scoreApp(app({ accountEnabled: false }), ctx({ maliciousAppIds: new Set(['app-1']) }));
    expect(r.score).toBe(100);
    expect(r.level).toBe('Critical');
    expect(ids(r)).toEqual(['knownMalicious']);
  });

  it('flags a Microsoft-looking name only when another organisation registered it', () => {
    expect(ids(scoreApp(app({ displayName: 'Microsoft 0utlook Sync', ownerTenant: 'Third party' }), ctx()))).toContain('impersonation');
    expect(ids(scoreApp(app({ displayName: 'Outlook add-in', ownerTenant: 'Third party' }), ctx()))).toContain('impersonation');
    expect(ids(scoreApp(app({ displayName: 'Microsoft Outlook Sync', ownerTenant: 'This tenant' }), ctx()))).not.toContain('impersonation');
    expect(ids(scoreApp(app({ displayName: 'Payroll', ownerTenant: 'Third party' }), ctx()))).not.toContain('impersonation');
  });

  it('flags an unverified third-party publisher only when the app reaches something', () => {
    const reach = { delegated: [scope('Files.Read.All', 'Medium', { userCount: 1 })] };
    expect(ids(scoreApp(app({ ownerTenant: 'Third party', ...reach }), ctx()))).toContain('unverifiedThirdParty');
    expect(ids(scoreApp(app({ ownerTenant: 'Third party', sp: { verifiedPublisherName: 'Contoso' }, ...reach }), ctx()))).not.toContain('unverifiedThirdParty');
    expect(ids(scoreApp(app({ ownerTenant: 'Third party', delegated: [scope('User.Read', 'Low', { userCount: 4 })] }), ctx()))).not.toContain('unverifiedThirdParty');
    expect(ids(scoreApp(app({ ownerTenant: 'This tenant', ...reach }), ctx()))).not.toContain('unverifiedThirdParty');
  });
});

describe('what it can reach', () => {
  it('scores app-only reach by the highest tier and names those permissions', () => {
    const r = scoreApp(app({ appPermissions: [perm('Sites.Read.All', 'High'), perm('Mail.ReadWrite', 'Critical'), perm('User.Read.All', 'Medium')] }), ctx());
    expect(pointsOf(r, 'appOnlyReach')).toBe(POINTS.appOnly.Critical);
    expect(r.findings.find(f => f.id === 'appOnlyReach').text).toContain('Mail.ReadWrite');
    expect(r.findings.find(f => f.id === 'appOnlyReach').text).not.toContain('Sites.Read.All');
    expect(pointsOf(scoreApp(app({ appPermissions: [perm('User.Read.All', 'Medium')] }), ctx()), 'appOnlyReach')).toBe(POINTS.appOnly.Medium);
    expect(ids(scoreApp(app({ appPermissions: [perm('x', 'Low'), perm('y', 'Unknown')] }), ctx()))).toEqual([]);
  });

  it('adds breadth per extra high-risk permission, capped', () => {
    const two = scoreApp(app({ appPermissions: [perm('a', 'High'), perm('b', 'Critical')] }), ctx());
    expect(pointsOf(two, 'appOnlyBreadth')).toBe(3);
    const five = scoreApp(app({ appPermissions: ['a', 'b', 'c', 'd', 'e'].map(p => perm(p, 'High')) }), ctx());
    expect(pointsOf(five, 'appOnlyBreadth')).toBe(POINTS.appOnlyBreadthMax);
    expect(ids(scoreApp(app({ appPermissions: [perm('a', 'High'), perm('b', 'Medium')] }), ctx()))).not.toContain('appOnlyBreadth');
  });

  it('scores admin consent by tier, ignoring scopes nobody admin-consented', () => {
    const r = scoreApp(app({ delegated: [scope('Mail.Send', 'High', { adminConsented: true }), scope('Files.ReadWrite.All', 'High', { userCount: 2 })] }), ctx());
    expect(pointsOf(r, 'adminConsent')).toBe(POINTS.adminConsent.High);
    expect(r.findings.find(f => f.id === 'adminConsent').text).toBe('An administrator consented on behalf of every user to Mail.Send');
    expect(ids(scoreApp(app({ delegated: [scope('User.Read', 'Low', { adminConsented: true })] }), ctx()))).not.toContain('adminConsent');
  });

  it('scores user consent by tier, with a bonus from ten consenting users', () => {
    const nine = scoreApp(app({ delegated: [scope('Mail.Send', 'High', { userCount: 9 })] }), ctx());
    expect(pointsOf(nine, 'userConsent')).toBe(POINTS.userConsent.High);
    const ten = scoreApp(app({ delegated: [scope('Mail.Send', 'High', { userCount: 10 }), scope('Files.Read.All', 'Medium', { userCount: 50 })] }), ctx());
    expect(pointsOf(ten, 'userConsent')).toBe(POINTS.userConsent.High + POINTS.userConsentManyUsers);
    expect(ten.findings.find(f => f.id === 'userConsent').text).toBe('10 user(s) personally consented to Mail.Send');
    expect(ids(scoreApp(app({ delegated: [scope('Mail.Send', 'High', { adminConsented: true })] }), ctx()))).not.toContain('userConsent');
  });

  it('reports the reach helpers over both kinds of permission', () => {
    const a = app({ appPermissions: [perm('a', 'Medium')], delegated: [scope('b', 'High')] });
    expect(appOnlyTier(a)).toBe('Medium');
    expect(reachTier(a)).toBe('High');
    expect(reachTier(app({ appPermissions: undefined, delegated: undefined }))).toBe('Unknown');
  });
});

describe('set-up', () => {
  it('flags public-client flows, more so with high-risk delegated reach', () => {
    expect(pointsOf(scoreApp(app({ reg: { isFallbackPublicClient: true } }), ctx()), 'publicClient')).toBe(POINTS.publicClient);
    const withReach = scoreApp(app({ reg: { isFallbackPublicClient: true }, delegated: [scope('Mail.Send', 'High')] }), ctx());
    expect(pointsOf(withReach, 'publicClient')).toBe(POINTS.publicClient + POINTS.publicClientWithReach);
    expect(ids(scoreApp(app({ reg: { isFallbackPublicClient: false } }), ctx()))).not.toContain('publicClient');
  });

  it('flags implicit access tokens but not ID tokens alone', () => {
    expect(ids(scoreApp(app({ reg: { implicitGrantAccessTokens: true } }), ctx()))).toContain('implicitAccessTokens');
    expect(ids(scoreApp(app({ reg: { implicitGrantAccessTokens: false, implicitGrantIdTokens: true } }), ctx()))).toEqual([]);
  });

  it('flags wildcard and http redirect URIs, but not http on localhost', () => {
    const r = scoreApp(app({
      reg: { webRedirectUris: 'https://*.contoso.com/cb,http://intranet.contoso.com/cb', publicClientRedirectUris: 'http://localhost:8080' },
      sp: { replyUrls: 'http://127.0.0.1/x,https://ok.contoso.com' },
    }), ctx());
    expect(r.findings.find(f => f.id === 'wildcardRedirect').text).toContain('https://*.contoso.com/cb');
    expect(r.findings.find(f => f.id === 'insecureRedirect').text).toBe('Unencrypted (http) redirect URI: http://intranet.contoso.com/cb');
    expect(ids(scoreApp(app({ reg: { webRedirectUris: 'https://ok.contoso.com,http://localhost' } }), ctx()))).toEqual([]);
  });

  it('treats only off-machine http as insecure, whatever the case or port', () => {
    expect(isInsecureRedirect('HTTP://Intranet.Contoso.com/cb')).toBe(true);
    expect(isInsecureRedirect('http://localhost.evil.com/cb')).toBe(true);   // not loopback, despite the name
    expect(isInsecureRedirect('http://LOCALHOST:5000/cb')).toBe(false);
    expect(isInsecureRedirect('http://[::1]:8400')).toBe(false);
    expect(isInsecureRedirect('https://contoso.com')).toBe(false);
    expect(isInsecureRedirect('ms-app://s-1-15-2-123/')).toBe(false);
    expect(isInsecureRedirect('not a uri')).toBe(false);
  });

  it('collects redirect URIs from both objects once each', () => {
    expect(redirectUris(app({ reg: { webRedirectUris: 'https://a, https://b', spaRedirectUris: 'https://a' }, sp: { replyUrls: 'https://b,https://c' } })))
      .toEqual(['https://a', 'https://b', 'https://c']);
  });

  it('flags only this tenant\'s own apps that accept any organisation', () => {
    expect(ids(scoreApp(app({ reg: { signInAudience: 'AzureADMultipleOrgs' } }), ctx()))).toContain('multiTenantOwnApp');
    expect(ids(scoreApp(app({ reg: { signInAudience: 'AzureADMyOrg' } }), ctx()))).toEqual([]);
    expect(ids(scoreApp(app({ ownerTenant: 'Third party', reg: { signInAudience: 'AzureADMultipleOrgs' } }), ctx()))).not.toContain('multiTenantOwnApp');
  });
});

describe('credentials', () => {
  it('grades secret lifetime: over ten years, over two years, two years', () => {
    expect(pointsOf(scoreApp(app({ reg: { secretMaxValidityDays: 3651 } }), ctx()), 'longLivedSecret')).toBe(POINTS.secretNeverExpires);
    expect(pointsOf(scoreApp(app({ reg: { secretMaxValidityDays: 3650 } }), ctx()), 'longLivedSecret')).toBe(POINTS.secretLongLived);
    expect(pointsOf(scoreApp(app({ reg: { secretMaxValidityDays: 731 } }), ctx()), 'longLivedSecret')).toBe(POINTS.secretLongLived);
    expect(ids(scoreApp(app({ reg: { secretMaxValidityDays: 730 } }), ctx()))).toEqual([]);
    // The longer of the registration's and the service principal's own counts.
    const r = scoreApp(app({ reg: { secretMaxValidityDays: 100 }, sp: { secretMaxValidityDays: 100746 } }), ctx());
    expect(r.findings.find(f => f.id === 'longLivedSecret').text).toContain('276 years');
  });

  it('flags a secret on the enterprise app itself, but not on a managed identity', () => {
    expect(pointsOf(scoreApp(app({ sp: { secretCount: 2 } }), ctx()), 'secretOnServicePrincipal')).toBe(POINTS.secretOnServicePrincipal);
    expect(ids(scoreApp(app({ principalType: 'ManagedIdentity', sp: { secretCount: 1 } }), ctx()))).toEqual([]);
    expect(ids(scoreApp(app({ sp: { secretCount: 0, certificateCount: 3 } }), ctx()))).toEqual([]);
  });

  it('counts expired credentials and simultaneously valid secrets', () => {
    const creds = [
      { type: 'Secret', endDateTime: daysAgo(1) },
      { type: 'Secret', endDateTime: daysAgo(-10) },
      { type: 'Secret', endDateTime: daysAgo(-20) },
      { type: 'Certificate', endDateTime: daysAgo(-30) },
    ];
    const r = scoreApp(app({ reg: { credentials: creds } }), ctx());
    expect(r.findings.find(f => f.id === 'expiredCredentials').text).toBe('1 expired credential(s) never cleaned up');
    expect(ids(r)).not.toContain('manyActiveSecrets');   // two valid secrets, not three
    const three = scoreApp(app({ reg: { credentials: creds }, sp: { credentials: [{ type: 'Secret', endDateTime: daysAgo(-5) }] } }), ctx());
    expect(three.findings.find(f => f.id === 'manyActiveSecrets').text).toBe('3 client secrets are valid at the same time');
  });

  it('flags a federated credential that matches a pattern', () => {
    const fics = [{ name: 'exact', subject: 'repo:c/p:ref:refs/heads/main' }, { name: 'star', subject: 'repo:c/*' }, { name: 'expr', claimsMatchingExpression: "claims['sub'] matches 'x'" }];
    expect(scoreApp(app({ reg: { federatedCredentials: fics } }), ctx()).findings.find(f => f.id === 'broadFederatedCredential').text).toContain('star, expr');
    expect(ids(scoreApp(app({ reg: { federatedCredentials: [fics[0]] } }), ctx()))).toEqual([]);
  });
});

describe('ownership', () => {
  const owner = (over = {}) => ({ id: 'u', principalType: 'User', accountEnabled: true, deleted: false, guest: false, ...over });

  it('flags disabled or deleted owners, and guest owners', () => {
    const r = scoreApp(app({ owners: [owner(), owner({ accountEnabled: false }), owner({ deleted: true }), owner({ guest: true })] }), ctx());
    expect(r.findings.find(f => f.id === 'ownerGone').text).toMatch(/^2 owner/);
    expect(r.findings.find(f => f.id === 'guestOwner').text).toMatch(/^1 guest/);
  });

  it('flags user owners of an app with critical app-only permissions, not of one with high', () => {
    const critical = scoreApp(app({ owners: [owner(), owner({ principalType: 'ServicePrincipal' }), owner({ accountEnabled: false })], appPermissions: [perm('RoleManagement.ReadWrite.Directory', 'Critical')] }), ctx());
    expect(critical.findings.find(f => f.id === 'ownerCanActAsApp').text).toMatch(/^1 user owner/);
    expect(ids(scoreApp(app({ owners: [owner()], appPermissions: [perm('Mail.Read', 'High')] }), ctx()))).not.toContain('ownerCanActAsApp');
  });

  it('says "no owner" only when owners were crawled, for this tenant\'s high-reach apps', () => {
    const reach = { appPermissions: [perm('Mail.Read', 'High')] };
    expect(ids(scoreApp(app({ owners: [], ...reach }), ctx()))).toContain('noOwner');
    expect(ids(scoreApp(app({ owners: null, ...reach }), ctx()))).not.toContain('noOwner');
    expect(ids(scoreApp(app({ owners: [], ownerTenant: 'Third party', ...reach }), ctx()))).not.toContain('noOwner');
    expect(ids(scoreApp(app({ owners: [], appPermissions: [perm('x', 'Medium')] }), ctx()))).not.toContain('noOwner');
  });
});

describe('activity', () => {
  const reach = { appPermissions: [perm('Mail.Read', 'High')] };

  it('flags a high-reach app idle past the window, or never signed in — only when activity was collected', () => {
    expect(scoreApp(app({ ...reach, activityKnown: true, lastSignIn: daysAgo(100) }), ctx()).findings.find(f => f.id === 'unusedButPowerful').text).toMatch(/^No sign-in for 100 days/);
    expect(ids(scoreApp(app({ ...reach, activityKnown: true, lastSignIn: daysAgo(89) }), ctx()))).not.toContain('unusedButPowerful');
    expect(scoreApp(app({ ...reach, activityKnown: true }), ctx()).findings.find(f => f.id === 'unusedButPowerful').text).toMatch(/^Never signed in/);
    expect(ids(scoreApp(app({ ...reach, activityKnown: false }), ctx()))).not.toContain('unusedButPowerful');
    expect(ids(scoreApp(app({ ...reach, activityKnown: true, lastSignIn: daysAgo(20) }), ctx({ inactiveDays: 14 })))).toContain('unusedButPowerful');
  });

  it('flags a new app that already holds critical permissions', () => {
    const critical = { appPermissions: [perm('Mail.ReadWrite', 'Critical')] };
    expect(ids(scoreApp(app({ ...critical, createdDateTime: daysAgo(10) }), ctx()))).toContain('newAndPowerful');
    expect(ids(scoreApp(app({ ...critical, createdDateTime: daysAgo(31) }), ctx()))).not.toContain('newAndPowerful');
    expect(ids(scoreApp(app({ ...reach, createdDateTime: daysAgo(10) }), ctx()))).not.toContain('newAndPowerful');
  });
});

describe('scoreApp', () => {
  it('sums the findings, sorted by points, and caps at 100', () => {
    const r = scoreApp(app({ appPermissions: [perm('Mail.ReadWrite', 'Critical')], reg: { secretMaxValidityDays: 100746, isFallbackPublicClient: true } }), ctx());
    expect(r.findings.map(f => f.points)).toEqual([40, 20, 10]);
    expect(r.score).toBe(70);
    expect(r.level).toBe('Critical');
    const capped = scoreApp(app({ appPermissions: [perm('a', 'Critical'), perm('b', 'Critical'), perm('c', 'Critical'), perm('d', 'Critical'), perm('e', 'Critical')],
      sp: { secretCount: 1, secretMaxValidityDays: 99999 }, reg: { isFallbackPublicClient: true, implicitGrantAccessTokens: true } }), ctx());
    expect(capped.score).toBe(100);
  });

  it('halves (rounding the reduction up) a disabled app\'s score and says why', () => {
    const r = scoreApp(app({ accountEnabled: false, appPermissions: [perm('Mail.Read', 'High')], reg: { implicitGrantAccessTokens: true } }), ctx());
    expect(r.score).toBe(15);    // 25 + 5 = 30, minus 15
    expect(r.findings.at(-1)).toMatchObject({ id: 'disabled', points: -15 });
    expect(r.level).toBe('Medium');
    expect(scoreApp(app({ accountEnabled: false }), ctx()).findings).toEqual([]);
  });

  it('maps scores to levels at the documented edges', () => {
    expect([100, 60, 59, 35, 34, 15, 14, 1, 0].map(levelFor))
      .toEqual(['Critical', 'Critical', 'High', 'High', 'Medium', 'Medium', 'Low', 'Low', 'None']);
  });

  it('has one rule per POINTS entry family it names', () => {
    expect(RULES.length).toBe(23);
  });
});
