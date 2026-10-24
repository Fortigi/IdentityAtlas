// Unit tests for the manager-link repair. The SQL itself is asserted against a
// real PostgreSQL in contract-tests/managerLinks.contract.test.js — a fake
// client can only prove which statement was sent, never that it selects the
// right rows.

import { describe, it, expect, vi } from 'vitest';
import {
  repairManagerLinks, managerLinkWarning, REPAIR_MANAGER_LINKS_SQL,
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

  it('returns null — and sends NOTHING — for a table that has no manager column', async () => {
    // Every entity ingest calls this; only the principals one may touch the DB.
    for (const table of ['Resources', 'ResourceAssignments', 'Identities', 'Contexts']) {
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
    const r = runner({ unresolved: 1, selfReferences: 0 });
    await expect(repairManagerLinks(r, 'Principals', 42, false)).resolves.toBeNull();
    expect(r.query).not.toHaveBeenCalled();
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
  it('batchHasManagerLink: true only when some record actually carries one', () => {
    expect(batchHasManagerLink([{ id: 'a' }, { id: 'b', managerId: 'm' }])).toBe(true);
    expect(batchHasManagerLink([{ id: 'a' }, { id: 'b' }])).toBe(false);
    // A batch that CLEARS everyone's manager writes nulls, and nothing it wrote
    // can dangle — so it needs no sweep either.
    expect(batchHasManagerLink([{ id: 'a', managerId: null }])).toBe(false);
    expect(batchHasManagerLink([{ id: 'a', managerId: undefined }])).toBe(false);
    expect(batchHasManagerLink([])).toBe(false);
    expect(batchHasManagerLink(null)).toBe(false);
    expect(batchHasManagerLink([null])).toBe(false);
  });

  it('columnsHaveManagerLink: true only when the session carries the column', () => {
    expect(columnsHaveManagerLink([{ name: 'id' }, { name: 'managerId' }])).toBe(true);
    expect(columnsHaveManagerLink([{ name: 'id' }, { name: 'managerIdentityId' }])).toBe(false);
    expect(columnsHaveManagerLink([])).toBe(false);
    expect(columnsHaveManagerLink(undefined)).toBe(false);
    expect(columnsHaveManagerLink([null])).toBe(false);
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
