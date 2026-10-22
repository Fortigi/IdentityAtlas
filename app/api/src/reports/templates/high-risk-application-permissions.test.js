// High-risk Application Permissions — the population it reads and the filter it
// applies. The mocked db is SQL-blind, so the population is asserted on the
// emitted predicates; the filter runs for real on fixture rows shaped like the
// query's output, so the acceptance cases (two rows for app A, none for app B,
// none for a look-alike API) run against the actual classification.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import report from './high-risk-application-permissions.js';

const GRAPH = '00000003-0000-0000-c000-000000000000';
const sqlOf = () => String(query.mock.calls[0][0]);

// One granted application permission as the query returns it.
const grant = (over = {}) => ({
  permissionId: 'perm-1',
  permission: 'Mail.Read', appRoleId: 'role-mail-read',
  apiSpId: 'graph-sp', apiName: 'Microsoft Graph', apiAppId: GRAPH,
  clientSpId: 'sp-a', clientType: 'ServicePrincipal', clientName: 'Scan-to-Mail',
  clientAppId: 'aaaaaaaa-0000-0000-0000-000000000001',
  publisher: 'Contoso Devices', systemName: 'Entra ID', lastSync: new Date('2026-10-21T02:00:00Z'),
  ...over,
});

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('high-risk-application-permissions — template contract', () => {
  it('is a list report with no parameters, registered under its slug', () => {
    expect(report).toMatchObject({ name: 'high-risk-application-permissions', form: 'list' });
    expect(report.displayName).toBe('High-risk Application Permissions (Entra ID)');
    expect(report.parametersSchema).toEqual({ type: 'object', required: [], properties: {} });
    expect(report.description).toMatch(/never listed/);
  });

  it('runs without a logger', async () => {
    await expect(report.run({}, undefined)).resolves.toBeTruthy();
  });
});

describe('high-risk-application-permissions — population', () => {
  it('reads live Direct grants on ApplicationPermission resources only', async () => {
    await report.run({}, {});
    const sql = sqlOf();
    expect(sql).toContain(`ap."resourceType" = 'ApplicationPermission'`);
    expect(sql).toContain(`ra."assignmentType" = 'Direct'`);
    expect(sql).toContain('ra."deletedAt" IS NULL');
    expect(sql).toContain('ap."deletedAt" IS NULL');
    // Delegated consent and user-to-app role assignments live under other
    // resource types; the report never names them, so it cannot include them.
    expect(sql).not.toContain('DelegatedPermission');
    expect(sql).not.toContain(`'AppRole'`);
  });

  it('identifies the target API by appId, with the API\'s own service-principal record as fallback', async () => {
    await report.run({}, {});
    const sql = sqlOf();
    expect(sql).toContain(`COALESCE(ap."extendedAttributes"->>'targetApiAppId', tsp."extendedAttributes"->>'appId') AS "apiAppId"`);
    expect(sql).toContain(`tsp.id::text = ap."extendedAttributes"->>'targetApiSpId'`);
  });

  it('reads the holder\'s appId from its Application resource and its publisher from its principal', async () => {
    await report.run({}, {});
    const sql = sqlOf();
    expect(sql).toContain(`app."resourceType" = 'Application'`);
    expect(sql).toContain(`csp."extendedAttributes"->>'publisherName' AS "publisher"`);
    expect(sql).toContain(`s."lastSyncDateTime" AS "lastSync"`);
  });
});

describe('high-risk-application-permissions — filter', () => {
  it('lists client A twice when it holds Sites.ReadWrite.All and Mail.Read on Microsoft Graph', async () => {
    query.mockResolvedValue({ rows: [
      grant({ permissionId: 'p1', permission: 'Sites.ReadWrite.All', appRoleId: 'role-sites' }),
      grant({ permissionId: 'p2', permission: 'Mail.Read', appRoleId: 'role-mail' }),
    ] });
    const { rows, notices } = await report.run({}, {});
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.permission)).toEqual(['Sites.ReadWrite.All', 'Mail.Read']);   // Critical before High
    expect(rows[0]).toMatchObject({
      clientName: 'Scan-to-Mail', clientAppId: 'aaaaaaaa-0000-0000-0000-000000000001', clientSpId: 'sp-a',
      apiName: 'Microsoft Graph', apiSpId: 'graph-sp', appRoleId: 'role-sites',
      permissionType: 'Application', status: 'Granted',
      category: 'SharePoint and OneDrive content', severity: 'Critical',
      publisher: 'Contoso Devices', systemName: 'Entra ID', lastSync: '2026-10-21T02:00:00.000Z',
    });
    expect(rows[0]._entity).toEqual({ kind: 'resource', id: 'sp-a' });
    for (const col of report.columns) expect(rows[0]).toHaveProperty(col.key);
    expect(notices).toEqual([]);
  });

  it('does not list client B when it only holds User.Read', async () => {
    query.mockResolvedValue({ rows: [grant({ clientSpId: 'sp-b', clientName: 'B', permission: 'User.Read' })] });
    const { rows, notices } = await report.run({}, {});
    expect(rows).toEqual([]);
    expect(notices).toEqual([]);   // grants were collected; none is high-risk
  });

  it('does not treat a same-named role on an unknown third API as Microsoft Graph access', async () => {
    query.mockResolvedValue({ rows: [grant({
      permission: 'Mail.Read', apiAppId: '99999999-9999-9999-9999-999999999999', apiName: 'Contoso Mail Gateway', apiSpId: 'other-sp',
    })] });
    const { rows, notices } = await report.run({}, {});
    expect(rows).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('names the API from the shortlist, not from the crawled display name', async () => {
    // The crawled name is whatever the assignment said; a renamed or localised
    // SP must still read as the API the appId identifies.
    query.mockResolvedValue({ rows: [grant({ apiName: 'Graph (renamed)' })] });
    const { rows } = await report.run({}, {});
    expect(rows[0].apiName).toBe('Microsoft Graph');
  });

  it('uses the fallback appId when the crawler had not stamped one', async () => {
    query.mockResolvedValue({ rows: [grant({ apiAppId: GRAPH.toUpperCase() })] });
    const { rows } = await report.run({}, {});
    expect(rows).toHaveLength(1);
  });

  it('warns about grants whose API could not be identified, and leaves them out', async () => {
    query.mockResolvedValue({ rows: [
      grant({ permissionId: 'p1' }),
      grant({ permissionId: 'p2', apiAppId: null, permission: 'Sites.FullControl.All' }),
      grant({ permissionId: 'p3', apiAppId: null, permission: 'User.Read' }),
    ] });
    const { rows, notices } = await report.run({}, {});
    expect(rows).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0].severity).toBe('warning');
    expect(notices[0].text).toMatch(/^2 granted permission\(s\) could not be matched/);
  });

  it('says that an empty result means nothing was collected, not that the tenant is clean', async () => {
    const { rows, notices } = await report.run({}, {});
    expect(rows).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ severity: 'info' });
    expect(notices[0].text).toMatch(/SyncAppPermissions/);
    expect(notices[0].text).toMatch(/not that the tenant holds no such grants/);
  });

  it('orders Critical before High, then by application, API and permission', async () => {
    query.mockResolvedValue({ rows: [
      grant({ permissionId: '1', clientName: 'Zeta', permission: 'Mail.Read' }),
      grant({ permissionId: '2', clientName: 'Alpha', permission: 'Sites.Read.All' }),
      grant({ permissionId: '3', clientName: 'Alpha', permission: 'Mail.Send' }),
      grant({ permissionId: '4', clientName: 'Alpha', permission: 'Files.ReadWrite.All' }),
      grant({ permissionId: '5', clientName: null, permission: 'Mail.Read' }),
    ] });
    const { rows } = await report.run({}, {});
    expect(rows.map(r => `${r.clientName}:${r.permission}`)).toEqual([
      'Alpha:Files.ReadWrite.All', 'Alpha:Mail.Send',     // Critical, by permission
      'null:Mail.Read', 'Alpha:Sites.Read.All', 'Zeta:Mail.Read',   // High, by application ('' sorts first)
    ]);
  });

  it('renders a missing sync moment and publisher as null rather than dropping the row', async () => {
    query.mockResolvedValue({ rows: [grant({ lastSync: null, publisher: null })] });
    const { rows } = await report.run({}, {});
    expect(rows[0].lastSync).toBeNull();
    expect(rows[0].publisher).toBeNull();
  });

  it('logs the high-risk count against the collected count', async () => {
    const log = vi.fn();
    query.mockResolvedValue({ rows: [grant(), grant({ permissionId: 'p2', permission: 'User.Read' })] });
    await report.run({}, { log });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/1 high-risk grant\(s\) of 2 granted/));
  });
});
