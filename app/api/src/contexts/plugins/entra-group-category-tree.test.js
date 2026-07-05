import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../../db/connection.js';

vi.mock('../../db/connection.js', () => ({ query: vi.fn() }));
const { default: plugin } = await import('./entra-group-category-tree.js');

const rows = [
  { id: 'g1', val: 'Team' },
  { id: 'g2', val: 'Team' },
  { id: 'g3', val: 'DynamicSecurityGroup' },
  { id: 'g4', val: 'DistributionList' },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockResolvedValue({ rows });
});

const ctx = { log: () => {} };

describe('entra-group-category-tree', () => {
  it('builds an "EntraID Groups" root with one child context per category', async () => {
    const { contexts } = await plugin.run({}, ctx);
    const root = contexts.find((c) => c.externalId === 'entra-groups-root');
    expect(root).toBeDefined();
    expect(root.displayName).toBe('EntraID Groups');
    expect(root.contextType).toBe('EntraGroupRoot');

    const exts = contexts.map((c) => c.externalId);
    expect(exts).toContain('category:Team');
    expect(exts).toContain('category:DynamicSecurityGroup');
    expect(exts).toContain('category:DistributionList');
    // categories hang off the single root
    for (const ext of ['category:Team', 'category:DynamicSecurityGroup', 'category:DistributionList']) {
      expect(contexts.find((c) => c.externalId === ext).parentExternalId).toBe('entra-groups-root');
      expect(contexts.find((c) => c.externalId === ext).contextType).toBe('EntraGroupCategory');
    }
  });

  it('places each group under its category as a member', async () => {
    const { members } = await plugin.run({}, ctx);
    expect(
      members.filter((m) => m.contextExternalId === 'category:Team').map((m) => m.memberId).sort(),
    ).toEqual(['g1', 'g2']);
    expect(members).toContainEqual({ contextExternalId: 'category:DistributionList', memberId: 'g4' });
  });

  it('honours a custom rootName', async () => {
    const { contexts } = await plugin.run({ rootName: 'My Groups' }, ctx);
    expect(contexts.find((c) => c.externalId === 'entra-groups-root').displayName).toBe('My Groups');
  });

  it('scopes the query to a system when scopeSystemId is given', async () => {
    await plugin.run({ scopeSystemId: 7 }, ctx);
    const [, qp] = db.query.mock.calls[0];
    expect(qp).toEqual([7]);
  });

  it('rejects a non-integer scopeSystemId', async () => {
    await expect(plugin.run({ scopeSystemId: 'nope' }, ctx)).rejects.toThrow(/integer/);
  });

  it('returns nothing when no groups carry a groupCategory', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const { contexts, members } = await plugin.run({}, ctx);
    expect(contexts).toEqual([]);
    expect(members).toEqual([]);
  });
});
