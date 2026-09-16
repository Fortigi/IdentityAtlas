import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query } from '../../db/connection.js';
import principalsPlugin from './system-membership-principals.js';
import resourcesPlugin from './system-membership-resources.js';
import { buildSystemQuery, buildSystemTree, ROOT_EXTERNAL_ID } from './system-membership.helpers.js';

// Two systems, one of which (id 3) has no rows at all — a LEFT JOIN row with a
// null memberId.
const twoSystems = [
  { systemId: 1, systemName: 'Fortigi Demo EntraID', memberId: 'p1' },
  { systemId: 1, systemName: 'Fortigi Demo EntraID', memberId: 'p2' },
  { systemId: 2, systemName: 'Fortigi Demo IGA', memberId: 'p3' },
  { systemId: 3, systemName: 'Fortigi Demo SAP ERP', memberId: null },
];

const ctx = { log: () => {} };

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: twoSystems });
});

describe('system-membership-principals', () => {
  it('emits one context per system, named after the system, under a principal root', async () => {
    const { contexts, members } = await principalsPlugin.run({}, ctx);

    const root = contexts.find(c => c.externalId === ROOT_EXTERNAL_ID);
    expect(root.displayName).toBe('Principals by system');

    // Keyed on Systems.id, labelled with the display name — not the numeric id.
    const entra = contexts.find(c => c.externalId === 'system:1');
    expect(entra.displayName).toBe('Fortigi Demo EntraID');
    expect(entra.parentExternalId).toBe(ROOT_EXTERNAL_ID);
    expect(contexts.filter(c => c.externalId !== ROOT_EXTERNAL_ID).map(c => c.externalId))
      .toEqual(['system:1', 'system:2', 'system:3']);

    expect(members.filter(m => m.contextExternalId === 'system:1').map(m => m.memberId))
      .toEqual(['p1', 'p2']);
    expect(members.filter(m => m.contextExternalId === 'system:2').map(m => m.memberId))
      .toEqual(['p3']);
    // The zero-row system still got a context, but no members.
    expect(members.some(m => m.contextExternalId === 'system:3')).toBe(false);
  });

  it('reads the Principals table and skips tombstoned rows', async () => {
    await principalsPlugin.run({}, ctx);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/LEFT JOIN "Principals"/);
    expect(sql).toMatch(/m\."deletedAt" IS NULL/);
  });

  it('honours a custom rootName', async () => {
    const { contexts } = await principalsPlugin.run({ rootName: 'Source systems' }, ctx);
    expect(contexts.find(c => c.externalId === ROOT_EXTERNAL_ID).displayName).toBe('Source systems');
  });

  it('targets Principal contexts', () => {
    expect(principalsPlugin.targetType).toBe('Principal');
  });
});

describe('system-membership-resources', () => {
  it('mirrors the principal side over the Resources table', async () => {
    const { contexts, members } = await resourcesPlugin.run({}, ctx);

    expect(resourcesPlugin.targetType).toBe('Resource');
    expect(contexts.find(c => c.externalId === ROOT_EXTERNAL_ID).displayName).toBe('Resources by system');
    expect(contexts.find(c => c.externalId === 'system:2').displayName).toBe('Fortigi Demo IGA');
    expect(members).toHaveLength(3);
    expect(String(query.mock.calls[0][0])).toMatch(/LEFT JOIN "Resources"/);
  });
});

describe('reconciliation on re-run', () => {
  it('drops a removed system from the output, leaving the runner to delete its context', async () => {
    query.mockResolvedValue({ rows: twoSystems.filter(r => r.systemId !== 2) });
    const { contexts } = await principalsPlugin.run({}, ctx);
    expect(contexts.map(c => c.externalId)).not.toContain('system:2');
    expect(contexts.map(c => c.externalId)).toContain('system:1');
  });

  it('keeps the externalId stable when a system is renamed, so the context updates in place', async () => {
    query.mockResolvedValue({ rows: [{ systemId: 1, systemName: 'Renamed Entra', memberId: 'p1' }] });
    const { contexts } = await principalsPlugin.run({}, ctx);
    const node = contexts.find(c => c.externalId === 'system:1');
    expect(node.displayName).toBe('Renamed Entra');
  });

  it('emits nothing when no systems are connected, so the whole tree reconciles away', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await principalsPlugin.run({}, ctx)).toEqual({ contexts: [], members: [] });
    expect(await resourcesPlugin.run({}, ctx)).toEqual({ contexts: [], members: [] });
  });
});

describe('helpers', () => {
  it('falls back to the id when a system has a blank display name', () => {
    const { contexts } = buildSystemTree(
      [{ systemId: 7, systemName: '   ', memberId: 'x' }],
      { rootName: 'R', rootType: 'SystemMembershipRoot', childType: 'SystemMembership' },
    );
    expect(contexts.find(c => c.externalId === 'system:7').displayName).toBe('System 7');
  });

  it('rejects a targetType that has no member table', () => {
    expect(() => buildSystemQuery('Identity')).toThrow(/Unsupported targetType/);
  });
});
