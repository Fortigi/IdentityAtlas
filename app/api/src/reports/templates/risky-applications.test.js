// Risky Applications — the template: its contract, its options, which apps make
// the list, and the notices that say what a run could not see. The data layer
// is replaced by row sets; the folding and the rules run for real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../appRiskData.js', async (importOriginal) => ({ ...(await importOriginal()), loadAppRiskRows: vi.fn() }));
vi.mock('../../contexts/plugins/riskyAppFeed.js', () => ({ DEFAULT_FEED_URL: 'https://feed.test/x.csv', fetchMaliciousAppIds: vi.fn() }));
import { loadAppRiskRows } from '../appRiskData.js';
import { fetchMaliciousAppIds } from '../../contexts/plugins/riskyAppFeed.js';
import report, { parseOptions, toRow, coverageNotices } from './risky-applications.js';

const GRAPH = '00000003-0000-0000-c000-000000000000';
const OWN = 'aaaaaaaa-0000-0000-0000-00000000000a';
const MICROSOFT = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';

const sp = (id, name, ext = {}, over = {}) => ({ id, displayName: name, principalType: 'ServicePrincipal', accountEnabled: true, ext: { appId: `app-${id}`, appOwnerOrganizationId: OWN, ...ext }, ...over });
const dataset = (over = {}) => ({
  apps: [
    sp('crit', 'Mailbox Archiver', { secretCount: 1, secretMaxValidityDays: 100746 }),   // 40 + 20 + 20 + no owner 5 + never signed in 10 = 95
    sp('high', 'Scan to Mail'),                                                          // 25 + no owner 5 = 30
    sp('quiet', 'Intranet'),                                                             // 0
    sp('ms', 'Office 365 Exchange Online', { appOwnerOrganizationId: MICROSOFT }),       // Microsoft, 40
  ],
  registrations: [{ ext: { appId: 'app-crit' } }],
  appPermissions: [
    { spId: 'crit', permission: 'Mail.ReadWrite', apiAppId: GRAPH },
    { spId: 'high', permission: 'Mail.Read', apiAppId: GRAPH },
    { spId: 'ms', permission: 'Mail.ReadWrite', apiAppId: GRAPH },
  ],
  delegated: [], owners: [], ownershipCrawled: true,
  activity: [{ spId: 'high', lastSignInDateTime: new Date().toISOString() }],
  tenantIds: [OWN],
  ...over,
});

beforeEach(() => {
  loadAppRiskRows.mockReset();
  loadAppRiskRows.mockResolvedValue(dataset());
  fetchMaliciousAppIds.mockReset();
  fetchMaliciousAppIds.mockResolvedValue(new Set());
});

describe('risky-applications — template contract', () => {
  it('is a list report with optional parameters the generic form can render', () => {
    expect(report).toMatchObject({ name: 'risky-applications', form: 'list', displayName: 'Risky Applications (Entra ID)' });
    expect(report.parametersSchema.required).toEqual([]);
    const p = report.parametersSchema.properties;
    expect(p.minimumLevel).toMatchObject({ type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'], default: 'Medium' });
    expect(p.includeMicrosoft).toMatchObject({ type: 'boolean', default: false });
    expect(p.useThreatFeed).toMatchObject({ type: 'boolean', default: true });
    expect(p.inactiveDays).toMatchObject({ type: 'integer', default: 90 });
    for (const c of report.columns) expect(c.key && c.label).toBeTruthy();
  });
});

describe('parseOptions', () => {
  it('applies the defaults and reads booleans in any form they arrive in', () => {
    expect(parseOptions()).toEqual({ minimumLevel: 'Medium', includeMicrosoft: false, useThreatFeed: true, inactiveDays: 90 });
    expect(parseOptions({ minimumLevel: 'Low', includeMicrosoft: 'true', useThreatFeed: 'false', inactiveDays: '30' }))
      .toEqual({ minimumLevel: 'Low', includeMicrosoft: true, useThreatFeed: false, inactiveDays: 30 });
    expect(parseOptions({ minimumLevel: 'None', useThreatFeed: false, inactiveDays: -1, includeMicrosoft: '' }))
      .toEqual({ minimumLevel: 'Medium', includeMicrosoft: false, useThreatFeed: false, inactiveDays: 90 });
  });
});

describe('risky-applications — run', () => {
  it('lists apps at or above Medium, highest score first, without Microsoft\'s own', async () => {
    const { rows } = await report.run({}, {});
    expect(rows.map(r => [r.application, r.score, r.level])).toEqual([
      ['Mailbox Archiver', 95, 'Critical'],
      ['Scan to Mail', 30, 'Medium'],
    ]);
    expect(rows[0]._entity).toEqual({ kind: 'resource', id: 'crit' });
  });

  it('adds Microsoft\'s apps on request and lower levels when asked', async () => {
    const { rows } = await report.run({ includeMicrosoft: true, minimumLevel: 'High' }, {});
    expect(rows.map(r => r.application)).toEqual(['Mailbox Archiver', 'Office 365 Exchange Online']);
  });

  it('flags an app on the malicious list as Critical through the feed', async () => {
    fetchMaliciousAppIds.mockResolvedValue(new Set(['app-quiet']));
    const { rows } = await report.run({ minimumLevel: 'Critical' }, {});
    expect(rows.map(r => r.application)).toEqual(['Intranet', 'Mailbox Archiver']);
    expect(rows[0].reasons).toMatch(/OAuthSentry/);
  });

  it('keeps running, and says so, when the feed cannot be read', async () => {
    fetchMaliciousAppIds.mockRejectedValue(new Error('HTTP 503'));
    const { rows, notices } = await report.run({}, {});
    expect(rows).toHaveLength(2);
    expect(notices.find(n => n.severity === 'warning').text).toMatch(/could not be read: HTTP 503/);
  });

  it('does not call the feed when it is switched off', async () => {
    const { notices } = await report.run({ useThreatFeed: false }, undefined);
    expect(fetchMaliciousAppIds).not.toHaveBeenCalled();
    expect(notices.some(n => /not consulted/.test(n.text))).toBe(true);
  });
});

describe('toRow', () => {
  it('summarises the app and puts the findings behind the score in words', () => {
    const app = {
      id: 'x', displayName: 'X', appId: 'a', principalType: 'AIAgent', ownerTenant: 'Third party', accountEnabled: false,
      sp: { publisherName: 'Acme', secretCount: 1, secretMaxValidityDays: 365 }, reg: { secretCount: 2, secretMaxValidityDays: 800, isFallbackPublicClient: false },
      appPermissions: [{ tier: 'High' }], delegated: [{ tier: 'Medium', adminConsented: true, userCount: 0 }, { tier: 'Low', userCount: 7 }],
      owners: [{}, {}], lastSignIn: new Date('2026-01-02T03:04:05Z'),
    };
    const row = toRow(app, { score: 12, level: 'Low', findings: [
      { category: 'Permissions', text: 'A', points: 25 }, { category: 'Credentials', text: 'B', points: 10 },
      { category: 'Configuration', text: 'C', points: 5 }, { category: 'Reputation', text: 'D', points: 3 },
      { category: 'Activity', text: 'Disabled', points: -21 }] });
    expect(row).toMatchObject({
      application: 'X', holderType: 'AIAgent', registeredIn: 'Third party', publisher: 'Acme', score: 12, level: 'Low',
      reasons: 'A · B · C', reach: 'High', appOnlyReach: 'High', applicationPermissions: 1, adminConsentedScopes: 1,
      consentingUsers: 7, secrets: 3, longestSecretYears: 2.2, publicClientFlows: false, owners: 2,
      lastSignIn: '2026-01-02T03:04:05.000Z', enabled: false,
    });
    expect(row.findings.split('\n')).toEqual(['Permissions: A (+25)', 'Credentials: B (+10)', 'Configuration: C (+5)', 'Reputation: D (+3)', 'Activity: Disabled (-21)']);
  });

  it('marks a verified publisher and leaves uncollected facts empty', () => {
    const row = toRow({ id: 'y', sp: { verifiedPublisherName: 'Contoso', publisherName: 'x' }, reg: null, owners: null, appPermissions: [], delegated: [] },
      { score: 0, level: 'None', findings: [] });
    expect(row).toMatchObject({ publisher: 'Contoso (verified)', secrets: 0, longestSecretYears: null, publicClientFlows: null, owners: null, lastSignIn: null, consentingUsers: 0, enabled: true });
  });
});

describe('coverageNotices', () => {
  const app = (over = {}) => ({ reg: { x: 1 }, owners: [], activityKnown: true, ...over });

  it('warns that there is nothing to judge without service principals, and stops there', () => {
    const n = coverageNotices({ apps: [], rows: [], feedError: 'x', useThreatFeed: true });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ severity: 'warning' });
    expect(n[0].text).toMatch(/Service Principals/);
  });

  it('names each missing source, and only those', () => {
    const missingAll = coverageNotices({ apps: [app({ reg: null, owners: null, activityKnown: false })], rows: [], feedError: null, useThreatFeed: true });
    expect(missingAll.map(n => n.text).join('\n')).toMatch(/App Registrations & Credentials[\s\S]*App Owners[\s\S]*sign-in activity/);
    const complete = coverageNotices({ apps: [app(), app({ reg: null })], rows: [{}], feedError: null, useThreatFeed: true });
    expect(complete).toEqual([{ severity: 'info', text: expect.stringMatching(/^1 of 2 apps scored/) }]);
  });
});
