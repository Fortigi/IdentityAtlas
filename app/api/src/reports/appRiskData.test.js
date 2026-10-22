// The fact objects the risky-applications rules read. buildAppFacts is pure and
// runs on row sets shaped like the queries' output; loadAppRiskRows is checked
// for what each query reads, against a SQL-blind mocked db.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { buildAppFacts, loadAppRiskRows, ownerTenantOf, latestSignIn } from './appRiskData.js';

const GRAPH = '00000003-0000-0000-c000-000000000000';
const OWN_TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';

const rows = (over = {}) => ({
  apps: [{ id: 'SP-1', displayName: 'Payroll', principalType: 'ServicePrincipal', accountEnabled: true, createdDateTime: '2024-01-01T00:00:00Z',
    ext: { appId: 'App-1', appOwnerOrganizationId: OWN_TENANT, secretCount: 1 } }],
  registrations: [{ ext: { appId: 'app-1', isFallbackPublicClient: true } }, { ext: { appId: 'other' } }, { ext: {} }],
  appPermissions: [
    { spId: 'sp-1', permission: 'Mail.ReadWrite', apiAppId: GRAPH },
    { spId: 'sp-2', permission: 'Mail.Read', apiAppId: GRAPH },
  ],
  delegated: [{ spId: 'SP-1', scope: 'Mail.Send', apiAppId: GRAPH, adminConsented: true, userCount: '3' }],
  owners: [{ spId: 'sp-1', ownerId: 'u1', principalType: 'User', accountEnabled: false, deleted: false, userType: 'Guest' }],
  ownershipCrawled: true,
  activity: [{ spId: 'sp-1', lastSignInDateTime: '2026-01-01T00:00:00Z', lastNonInteractiveSignInDateTime: null, ext: { lastApplicationAuthSignInDateTime: '2026-03-01T00:00:00Z' } }],
  tenantIds: [OWN_TENANT],
  ...over,
});

describe('buildAppFacts', () => {
  it('folds every kind of row onto its app, matching ids and appIds case-insensitively', () => {
    const [a] = buildAppFacts(rows());
    expect(a).toMatchObject({ id: 'SP-1', displayName: 'Payroll', appId: 'App-1', ownerTenant: 'This tenant', activityKnown: true });
    expect(a.reg).toEqual({ appId: 'app-1', isFallbackPublicClient: true });
    expect(a.sp.secretCount).toBe(1);
    // Only sp-1's grant, tiered as an app-only permission (Critical, not the delegated tier).
    expect(a.appPermissions).toEqual([{ permission: 'Mail.ReadWrite', apiAppId: GRAPH, tier: 'Critical' }]);
    expect(a.delegated).toEqual([{ scope: 'Mail.Send', apiAppId: GRAPH, adminConsented: true, userCount: 3, tier: 'High' }]);
    expect(a.owners).toEqual([{ id: 'u1', principalType: 'User', accountEnabled: false, deleted: false, guest: true }]);
    expect(a.lastSignIn.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('keeps uncollected facts null, so "no owners" and "owners not crawled" stay apart', () => {
    const [a] = buildAppFacts(rows({ ownershipCrawled: false, activity: [], registrations: [] }));
    expect(a.owners).toBeNull();
    expect(a.activityKnown).toBe(false);
    expect(a.lastSignIn).toBeNull();
    expect(a.reg).toBeNull();
    const [b] = buildAppFacts(rows({ owners: [] }));
    expect(b.owners).toEqual([]);
  });

  it('copes with an app that has no appId and with missing row sets', () => {
    const [a] = buildAppFacts({ apps: [{ id: 'x', displayName: 'Bare', principalType: 'ManagedIdentity', ext: null }] });
    expect(a).toMatchObject({ appId: null, reg: null, ownerTenant: 'Unknown', appPermissions: [], delegated: [], owners: null });
    expect(buildAppFacts({})).toEqual([]);
  });
});

describe('ownerTenantOf', () => {
  it('tells Microsoft, this tenant, a third party and unknown apart', () => {
    const own = new Set([OWN_TENANT]);
    expect(ownerTenantOf('F8CDEF31-A31E-4B4A-93E4-5F571E91255A', own)).toBe('Microsoft');
    expect(ownerTenantOf('72f988bf-86f1-41af-91ab-2d7cd011db47', own)).toBe('Microsoft');
    expect(ownerTenantOf(OWN_TENANT.toUpperCase(), own)).toBe('This tenant');
    expect(ownerTenantOf('bbbbbbbb-0000-0000-0000-00000000000b', own)).toBe('Third party');
    expect(ownerTenantOf(null, own)).toBe('Unknown');
  });
});

describe('latestSignIn', () => {
  it('takes the latest of all four timestamps, wherever it sits', () => {
    expect(latestSignIn({ lastSignInDateTime: '2026-01-01T00:00:00Z', lastNonInteractiveSignInDateTime: '2026-05-01T00:00:00Z',
      ext: { lastDelegatedClientSignInDateTime: '2026-02-01T00:00:00Z' } }).toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(latestSignIn({ ext: { lastDelegatedClientSignInDateTime: '2026-02-01T00:00:00Z' } }).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(latestSignIn({ lastSignInDateTime: 'garbage', ext: null })).toBeNull();
    expect(latestSignIn({})).toBeNull();
  });
});

describe('loadAppRiskRows', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT EXISTS')) return { rows: [{ crawled: true }] };
      if (sql.includes('"Systems"')) return { rows: [{ tenantId: 'ABC' }] };
      return { rows: [] };
    });
  });

  it('runs one query per fact and returns them under their names', async () => {
    const out = await loadAppRiskRows();
    expect(query).toHaveBeenCalledTimes(8);
    expect(out).toMatchObject({ apps: [], registrations: [], appPermissions: [], delegated: [], owners: [], activity: [], ownershipCrawled: true, tenantIds: ['abc'] });
  });

  it('reads live rows of the right kinds only', async () => {
    await loadAppRiskRows();
    const sql = query.mock.calls.map(c => String(c[0])).join('\n');
    expect(sql).toContain(`p."principalType" IN ('ServicePrincipal', 'ManagedIdentity', 'AIAgent')`);
    expect(sql).toContain(`r."resourceType" = 'AppRegistration'`);
    expect(sql).toContain(`ap."resourceType" = 'ApplicationPermission'`);
    expect(sql).toContain(`dp."resourceType" = 'DelegatedPermission'`);
    expect(sql).toContain(`own."resourceType" IN ('ServicePrincipalOwnership', 'ApplicationOwnership')`);
    expect(sql).toContain(`"activityType" = 'ServicePrincipalSignIn'`);
    expect(sql).toContain(`"systemType" = 'EntraID'`);
    // A deleted owner is what we look for, so the owner's row is NOT filtered on deletedAt.
    expect(sql).toMatch(/LEFT JOIN "Principals" o ON o\.id = ra\."principalId"\n/);
  });

  it('reads "not crawled" when the existence check finds no ownership', async () => {
    query.mockImplementation(async (sql) => (sql.includes('SELECT EXISTS') ? { rows: [{ crawled: false }] } : { rows: [] }));
    expect((await loadAppRiskRows()).ownershipCrawled).toBe(false);
  });
});
