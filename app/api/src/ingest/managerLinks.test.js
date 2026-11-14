// Unit tests for the manager-link repair. The SQL itself is asserted against a
// real PostgreSQL in contract-tests/managerLinks.contract.test.js — a fake
// client can only prove which statement was sent, never that it selects the
// right rows.

import { describe, it, expect, vi } from 'vitest';
import {
  repairManagerLinks, managerLinkWarning, REPAIR_MANAGER_LINKS_SQL,
  REPAIR_IDENTITY_MANAGER_LINKS_SQL, managerLinkColumn,
  batchHasManagerLink, columnsHaveManagerLink,
} from './managerLinks.js';

const runner = (row) => ({ query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) });

describe('repairManagerLinks', () => {
  it('runs against the loading system only, and returns both counts', async () => {
    const r = runner({ unresolved: 3, selfReferences: 1 });
    await expect(repairManagerLinks(r, 'Principals', 42, true)).resolves.toEqual({ unresolved: 3, selfReferences: 1 });
    expect(r.query).toHaveBeenCalledTimes(1);
    expect(r.query).toHaveBeenCalledWith(REPAIR_MANAGER_LINKS_SQL, [42]);
  });

  it('sweeps identities with the identity statement, unscoped (#1216)', async () => {
    // "Identities" has no systemId column, so the statement binds no parameter —
    // and sending the principals statement here would clear the wrong table.
    const r = runner({ unresolved: 2, selfReferences: 1 });
    await expect(repairManagerLinks(r, 'Identities', 42, true)).resolves.toEqual({ unresolved: 2, selfReferences: 1 });
    expect(r.query).toHaveBeenCalledTimes(1);
    expect(r.query).toHaveBeenCalledWith(REPAIR_IDENTITY_MANAGER_LINKS_SQL, []);
  });

  it('sweeps identities even when the envelope names no system', async () => {
    // The guard below exists for the SCOPED sweep. Applying it to the unscoped
    // one would silently disarm the identity repair for a caller with no system.
    const r = runner({ unresolved: 1, selfReferences: 0 });
    await expect(repairManagerLinks(r, 'Identities', null, true)).resolves.toEqual({ unresolved: 1, selfReferences: 0 });
    expect(r.query).toHaveBeenCalledWith(REPAIR_IDENTITY_MANAGER_LINKS_SQL, []);
  });

  it('returns null — and sends NOTHING — for a table that has no manager link', async () => {
    // Every entity ingest calls this; only the two tables that carry a manager
    // link may touch the DB. "Contexts" has both column NAMES but no
    // self-referential link this sweep can repair.
    for (const table of ['Resources', 'ResourceAssignments', 'Contexts', 'IdentityMembers']) {
      const r = runner({ unresolved: 9, selfReferences: 9 });
      await expect(repairManagerLinks(r, table, 42, true)).resolves.toBeNull();
      expect(r.query).not.toHaveBeenCalled();
    }
  });

  it('does nothing when no system is known — a system-wide sweep is not this call\'s business', async () => {
    for (const sid of [undefined, null]) {
      const r = runner({ unresolved: 1, selfReferences: 0 });
      await expect(repairManagerLinks(r, 'Principals', sid, true)).resolves.toBeNull();
      expect(r.query).not.toHaveBeenCalled();
    }
  });

  it('does nothing for a load that wrote no manager — the sweep is not free', async () => {
    // The Entra photo phase posts hundreds of principal batches carrying an id
    // and an image. Each one running an anti-join over 176k principals is the
    // shape of regression this guard exists for.
    for (const table of ['Principals', 'Identities']) {
      const r = runner({ unresolved: 1, selfReferences: 0 });
      await expect(repairManagerLinks(r, table, 42, false)).resolves.toBeNull();
      expect(r.query).not.toHaveBeenCalled();
    }
  });

  it('still runs for system 0 (a falsy id is an id)', async () => {
    const r = runner({ unresolved: 2, selfReferences: 0 });
    await expect(repairManagerLinks(r, 'Principals', 0, true)).resolves.toEqual({ unresolved: 2, selfReferences: 0 });
    expect(r.query).toHaveBeenCalledWith(REPAIR_MANAGER_LINKS_SQL, [0]);
  });

  it('returns null when nothing was broken, so a clean load reports nothing', async () => {
    await expect(repairManagerLinks(runner({ unresolved: 0, selfReferences: 0 }), 'Principals', 1, true)).resolves.toBeNull();
  });

  it('survives a driver that returns no rows', async () => {
    await expect(repairManagerLinks(runner(null), 'Principals', 1, true)).resolves.toBeNull();
    await expect(repairManagerLinks({ query: vi.fn().mockResolvedValue(undefined) }, 'Principals', 1, true)).resolves.toBeNull();
  });

  it('reports a self-reference on its own, without inventing an unresolved one', async () => {
    await expect(repairManagerLinks(runner({ unresolved: 0, selfReferences: 5 }), 'Principals', 1, true))
      .resolves.toEqual({ unresolved: 0, selfReferences: 5 });
  });
});

describe('did this load write a manager at all?', () => {
  it('managerLinkColumn: each table\'s own column, and null for the rest', () => {
    expect(managerLinkColumn('Principals')).toBe('managerId');
    expect(managerLinkColumn('Identities')).toBe('managerIdentityId');
    // Contexts carries both column names (an org unit's manager account); it is
    // not a self-referential link, so this sweep does not own it.
    expect(managerLinkColumn('Contexts')).toBeNull();
    expect(managerLinkColumn('Resources')).toBeNull();
    expect(managerLinkColumn(undefined)).toBeNull();
    // A null-prototype lookup: an inherited member is not a column name.
    expect(managerLinkColumn('constructor')).toBeNull();
  });

  it('batchHasManagerLink: true only when some record actually carries one', () => {
    expect(batchHasManagerLink([{ id: 'a' }, { id: 'b', managerId: 'm' }], 'Principals')).toBe(true);
    expect(batchHasManagerLink([{ id: 'a' }, { id: 'b' }], 'Principals')).toBe(false);
    // A batch that CLEARS everyone's manager writes nulls, and nothing it wrote
    // can dangle — so it needs no sweep either.
    expect(batchHasManagerLink([{ id: 'a', managerId: null }], 'Principals')).toBe(false);
    expect(batchHasManagerLink([{ id: 'a', managerId: undefined }], 'Principals')).toBe(false);
    expect(batchHasManagerLink([], 'Principals')).toBe(false);
    expect(batchHasManagerLink(null, 'Principals')).toBe(false);
    expect(batchHasManagerLink([null], 'Principals')).toBe(false);
  });

  it('batchHasManagerLink: reads the column the TABLE has, not the other one', () => {
    const identityRec = [{ id: 'a', managerIdentityId: 'm' }];
    expect(batchHasManagerLink(identityRec, 'Identities')).toBe(true);
    // The identity column on a principals batch is not a principal manager …
    expect(batchHasManagerLink(identityRec, 'Principals')).toBe(false);
    // … and vice versa: an identities feed that carries managerId (every
    // person-shaped CSV does) must not arm the identities sweep on it.
    expect(batchHasManagerLink([{ id: 'a', managerId: 'm' }], 'Identities')).toBe(false);
    // A table with no manager link never arms the sweep, whatever it carries.
    expect(batchHasManagerLink([{ id: 'a', managerId: 'm' }], 'Contexts')).toBe(false);
    expect(batchHasManagerLink([{ id: 'a', managerId: 'm' }], undefined)).toBe(false);
  });

  it('columnsHaveManagerLink: true only when the session carries the column', () => {
    expect(columnsHaveManagerLink([{ name: 'id' }, { name: 'managerId' }], 'Principals')).toBe(true);
    expect(columnsHaveManagerLink([{ name: 'id' }, { name: 'managerIdentityId' }], 'Principals')).toBe(false);
    expect(columnsHaveManagerLink([], 'Principals')).toBe(false);
    expect(columnsHaveManagerLink(undefined, 'Principals')).toBe(false);
    expect(columnsHaveManagerLink([null], 'Principals')).toBe(false);
  });

  it('columnsHaveManagerLink: an identities session is armed by its own column', () => {
    expect(columnsHaveManagerLink([{ name: 'id' }, { name: 'managerIdentityId' }], 'Identities')).toBe(true);
    expect(columnsHaveManagerLink([{ name: 'id' }, { name: 'managerId' }], 'Identities')).toBe(false);
    expect(columnsHaveManagerLink([{ name: 'managerId' }], 'Contexts')).toBe(false);
  });
});

describe('managerLinkWarning', () => {
  it('says nothing when nothing was repaired', () => {
    expect(managerLinkWarning(null)).toBeNull();
    expect(managerLinkWarning(undefined)).toBeNull();
  });

  it('names only the half that happened', () => {
    expect(managerLinkWarning({ unresolved: 4, selfReferences: 0 }))
      .toBe('Manager links cleared: 4 named a manager that was not loaded.');
    expect(managerLinkWarning({ unresolved: 0, selfReferences: 2 }))
      .toBe('Manager links cleared: 2 named themselves as manager.');
  });

  it('names both when both happened', () => {
    expect(managerLinkWarning({ unresolved: 4, selfReferences: 2 }))
      .toBe('Manager links cleared: 4 named a manager that was not loaded; 2 named themselves as manager.');
  });
});

describe('REPAIR_MANAGER_LINKS_SQL', () => {
  it('clears the column rather than deleting the row', () => {
    expect(REPAIR_MANAGER_LINKS_SQL).toContain('SET "managerId" = NULL');
    expect(REPAIR_MANAGER_LINKS_SQL).not.toMatch(/DELETE/i);
  });

  it('is scoped to one system, so it cannot clear another crawler\'s links', () => {
    expect(REPAIR_MANAGER_LINKS_SQL).toContain('p."systemId" = $1');
  });
});

describe('REPAIR_IDENTITY_MANAGER_LINKS_SQL', () => {
  it('clears the identity column on the identities table, not the principals one', () => {
    expect(REPAIR_IDENTITY_MANAGER_LINKS_SQL).toContain('UPDATE "Identities" SET "managerIdentityId" = NULL');
    expect(REPAIR_IDENTITY_MANAGER_LINKS_SQL).not.toContain('"Principals"');
    expect(REPAIR_IDENTITY_MANAGER_LINKS_SQL).not.toMatch(/DELETE/i);
  });

  it('binds no parameter — "Identities" has no systemId to scope by', () => {
    expect(REPAIR_IDENTITY_MANAGER_LINKS_SQL).not.toContain('$1');
  });

  it('keeps a link that resolves, and clears a self-reference', () => {
    // The two halves of "points at nobody", both of which the counts split on.
    expect(REPAIR_IDENTITY_MANAGER_LINKS_SQL).toContain('i."managerIdentityId" = i.id');
    expect(REPAIR_IDENTITY_MANAGER_LINKS_SQL)
      .toContain('NOT EXISTS (SELECT 1 FROM "Identities" m WHERE m.id = i."managerIdentityId")');
  });
});
