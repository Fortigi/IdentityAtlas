// Where the relative-permission policy is kept (auth/contextOwnerSetting.js):
// read once from WorkerConfig, held in memory, replaced in place by the admin
// route — and, until the grid was ever saved, derived from the four switches it
// replaced so an upgrade keeps exactly the access people had.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js');
const { query } = await import('../db/connection.js');
const {
  RELATIVE_PERMISSIONS_KEY, LEGACY_KEYS, getRelativePolicy, setRelativePolicy, isContextOwnerMcpEnabled,
  resetContextOwnerSettingForTests,
} = await import('./contextOwnerSetting.js');
const { legacyPolicy } = await import('./relativePermissions.js');

const savedUseSql = process.env.USE_SQL;

// WorkerConfig holds `values` (configKey → configValue).
const stored = (values) => query.mockImplementation(async () => ({
  rows: Object.entries(values).map(([configKey, configValue]) => ({ configKey, configValue })),
}));

beforeEach(() => {
  query.mockReset();
  resetContextOwnerSettingForTests();
  process.env.USE_SQL = 'true';
});
afterEach(() => {
  if (savedUseSql === undefined) delete process.env.USE_SQL;
  else process.env.USE_SQL = savedUseSql;
});

describe('getRelativePolicy — a saved grid', () => {
  it('reads the grid and every legacy key in one query', async () => {
    stored({});
    await getRelativePolicy();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([[RELATIVE_PERMISSIONS_KEY, ...Object.values(LEGACY_KEYS)]]);
  });

  it('uses the saved grid and ignores the legacy switches once it exists', async () => {
    stored({
      [RELATIVE_PERMISSIONS_KEY]: JSON.stringify({ OrganizationalUnit: { Accountable: { view: true } } }),
      CONTEXT_OWNER_ACCESS: 'true',
    });
    const policy = await getRelativePolicy();
    expect(policy.OrganizationalUnit.Accountable).toEqual({ view: true, subUnits: false, mcp: false });
    expect(policy.OrganizationalUnit.Responsible.view).toBe(false);
  });

  it('treats a grid that is not JSON as everything off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stored({ [RELATIVE_PERMISSIONS_KEY]: '{not json', CONTEXT_OWNER_ACCESS: 'true' });
    expect(await getRelativePolicy()).toEqual(legacyPolicy());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is held after the first read', async () => {
    stored({});
    await getRelativePolicy();
    await getRelativePolicy();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('getRelativePolicy — before the grid was saved (upgrade)', () => {
  it('stands for the old switches: access on → every template, both roles, with sub-units', async () => {
    stored({ CONTEXT_OWNER_ACCESS: 'true' });
    const policy = await getRelativePolicy();
    for (const role of ['Accountable', 'Responsible']) {
      expect(policy.OrganizationalUnit[role]).toEqual({ view: true, subUnits: true, mcp: false });
      expect(policy.LogicalApplication[role]).toEqual({ view: true, subUnits: true, mcp: false });
      expect(policy.BusinessRole[role]).toEqual({ view: false, review: false });
    }
  });

  it('maps MCP, business roles and owner review the way the switches worked', async () => {
    stored({ CONTEXT_OWNER_ACCESS: 'true', CONTEXT_OWNER_MCP: 'true', CONTEXT_OWNER_BUSINESS_ROLES: 'true', BUSINESS_ROLE_OWNER_REVIEW: 'true' });
    const policy = await getRelativePolicy();
    expect(policy.OrganizationalUnit.Responsible.mcp).toBe(true);
    expect(policy.BusinessRole.Responsible).toEqual({ view: true, review: true });
  });

  it('keeps MCP and business roles off while access was off, but owner review on its own', async () => {
    stored({ CONTEXT_OWNER_ACCESS: 'false', CONTEXT_OWNER_MCP: 'true', CONTEXT_OWNER_BUSINESS_ROLES: 'true', BUSINESS_ROLE_OWNER_REVIEW: 'true' });
    const policy = await getRelativePolicy();
    expect(policy.OrganizationalUnit.Accountable).toEqual({ view: false, subUnits: false, mcp: false });
    expect(policy.BusinessRole.Accountable).toEqual({ view: false, review: true });
  });

  it('is on only for the exact stored value "true"', async () => {
    stored({ CONTEXT_OWNER_ACCESS: 'TRUE' });
    expect((await getRelativePolicy()).OrganizationalUnit.Accountable.view).toBe(false);
  });
});

describe('getRelativePolicy — no database', () => {
  it('is everything off without a database, and does not query', async () => {
    delete process.env.USE_SQL;
    expect(await getRelativePolicy()).toEqual(legacyPolicy());
    expect(query).not.toHaveBeenCalled();
  });

  it('does not remember a failed read: off now, the stored value once the table exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    query.mockRejectedValueOnce(new Error('relation "WorkerConfig" does not exist'));
    expect(await getRelativePolicy()).toEqual(legacyPolicy());
    stored({ CONTEXT_OWNER_ACCESS: 'true' });
    expect((await getRelativePolicy()).OrganizationalUnit.Accountable.view).toBe(true);
    warn.mockRestore();
  });
});

describe('setRelativePolicy', () => {
  it('saves the normalized grid as JSON and puts it in force without another read', async () => {
    query.mockResolvedValue({ rows: [] });
    const saved = await setRelativePolicy({ OrganizationalUnit: { Responsible: { view: true, mcp: true } }, Tag: { x: 1 } });
    expect(query).toHaveBeenCalledTimes(1);
    const [key, value] = query.mock.calls[0][1];
    expect(key).toBe(RELATIVE_PERMISSIONS_KEY);
    expect(JSON.parse(value)).toEqual(saved);
    expect(saved.Tag).toBeUndefined();
    expect(saved.OrganizationalUnit.Responsible).toEqual({ view: true, subUnits: false, mcp: true });
    expect(await getRelativePolicy()).toBe(saved);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('holds the value without writing when there is no database', async () => {
    delete process.env.USE_SQL;
    const saved = await setRelativePolicy({ BusinessRole: { Accountable: { review: true } } });
    expect(query).not.toHaveBeenCalled();
    expect((await getRelativePolicy()).BusinessRole.Accountable.review).toBe(true);
    expect(saved.BusinessRole.Accountable.review).toBe(true);
  });

  it('keeps the previous value when the write fails', async () => {
    stored({});
    const before = await getRelativePolicy();
    query.mockRejectedValueOnce(new Error('disk full'));
    await expect(setRelativePolicy({ OrganizationalUnit: { Accountable: { view: true } } })).rejects.toThrow('disk full');
    expect(await getRelativePolicy()).toBe(before);
  });
});

describe('isContextOwnerMcpEnabled', () => {
  it('is on when any context row gives mcp, whichever role', async () => {
    query.mockResolvedValue({ rows: [] });
    await setRelativePolicy({ LogicalApplication: { Responsible: { view: true, mcp: true } } });
    expect(await isContextOwnerMcpEnabled()).toBe(true);
  });

  it('is off when only view is given', async () => {
    query.mockResolvedValue({ rows: [] });
    await setRelativePolicy({ OrganizationalUnit: { Accountable: { view: true, subUnits: true } } });
    expect(await isContextOwnerMcpEnabled()).toBe(false);
  });
});
