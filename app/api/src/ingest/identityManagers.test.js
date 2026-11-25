import { describe, it, expect, vi } from 'vitest';
import {
  DERIVE_IDENTITY_MANAGERS_SQL, shouldDeriveIdentityManagers, deriveIdentityManagers, deriveIdentityManagersAfterLoad,
} from './identityManagers.js';

// The statement's behaviour on real rows is pinned by
// contract-tests/identityManagerDerivation.contract.test.js. These pin the
// guard rails a refactor of the text could drop silently, and the JS around it.
const sql = DERIVE_IDENTITY_MANAGERS_SQL.replace(/\s+/g, ' ');

describe('DERIVE_IDENTITY_MANAGERS_SQL guard rails', () => {
  it('skips rejected links on both hops', () => {
    expect(sql.match(/"analystOverride" IS DISTINCT FROM 'rejected'/g)).toHaveLength(2);
  });

  it('ranks the HR-authoritative account first, then the primary one', () => {
    expect(sql).toContain('ORDER BY im."isHrAuthoritative" DESC NULLS LAST, im."isPrimary" DESC NULLS LAST');
  });

  it('resolves a manager account linked to several persons to the lowest id', () => {
    expect(sql).toMatch(/ORDER BY m\."identityId" LIMIT 1/);
  });

  it('only fills empty rows and rows it derived itself — never a source-set manager', () => {
    expect(sql).toContain(`(i."managerIdentitySource" = 'Derived' OR (i."managerIdentitySource" IS NULL AND i."managerIdentityId" IS NULL))`);
    expect(sql).not.toMatch(/"managerIdentitySource" = 'Source'/);
  });

  it('refuses a self-manager, an unresolved deciding account and a disagreeing tie', () => {
    expect(sql).toContain('count("managerIdentityId") = count(*)');
    expect(sql).toContain('count(DISTINCT "managerIdentityId") = 1');
    expect(sql).toContain('bool_and("managerIdentityId" <> "identityId")');
  });

  it('is not system-scoped (Identities has no systemId)', () => {
    expect(sql).not.toMatch(/\$1|systemId/);
  });
});

describe('shouldDeriveIdentityManagers', () => {
  it('runs after every identity-members load, whatever it carried', () => {
    expect(shouldDeriveIdentityManagers('IdentityMembers', false)).toBe(true);
    expect(shouldDeriveIdentityManagers('IdentityMembers', undefined)).toBe(true);
  });

  it.each(['Principals', 'Identities'])('runs after a %s load only when it wrote a manager link', (table) => {
    expect(shouldDeriveIdentityManagers(table, true)).toBe(true);
    expect(shouldDeriveIdentityManagers(table, false)).toBe(false);
    // Truthy is not enough: the guards return booleans, anything else is a bug upstream.
    expect(shouldDeriveIdentityManagers(table, 1)).toBe(false);
  });

  it('never runs for a table that cannot change a manager', () => {
    expect(shouldDeriveIdentityManagers('Resources', true)).toBe(false);
    expect(shouldDeriveIdentityManagers('Contexts', true)).toBe(false);
  });
});

describe('deriveIdentityManagers', () => {
  it('runs the statement without parameters and returns its counts', async () => {
    const runner = { query: vi.fn().mockResolvedValue({ rows: [{ derived: 4, cleared: 2 }] }) };
    expect(await deriveIdentityManagers(runner)).toEqual({ derived: 4, cleared: 2 });
    expect(runner.query).toHaveBeenCalledWith(DERIVE_IDENTITY_MANAGERS_SQL);
  });

  it('reads a missing row as nothing changed', async () => {
    const runner = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await deriveIdentityManagers(runner)).toEqual({ derived: 0, cleared: 0 });
  });
});

describe('deriveIdentityManagersAfterLoad', () => {
  it('costs nothing for a load that could not have changed a manager', async () => {
    const runner = { query: vi.fn() };
    expect(await deriveIdentityManagersAfterLoad(runner, 'Principals', false)).toBeNull();
    expect(runner.query).not.toHaveBeenCalled();
  });

  it('derives after a load that could have', async () => {
    const runner = { query: vi.fn().mockResolvedValue({ rows: [{ derived: 1, cleared: 0 }] }) };
    expect(await deriveIdentityManagersAfterLoad(runner, 'IdentityMembers', false)).toEqual({ derived: 1, cleared: 0 });
    expect(runner.query).toHaveBeenCalledTimes(1);
  });
});
