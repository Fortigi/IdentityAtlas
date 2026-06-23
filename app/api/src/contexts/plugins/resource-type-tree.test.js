import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../../db/connection.js';

vi.mock('../../db/connection.js', () => ({ query: vi.fn() }));
const { default: plugin } = await import('./resource-type-tree.js');

const rows = [
  { id: 'vm1', val: 'Microsoft.Compute/virtualMachines' },
  { id: 'vm2', val: 'Microsoft.Compute/virtualMachines' },
  { id: 'sa1', val: 'Microsoft.Storage/storageAccounts' },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockResolvedValue({ rows });
});

const ctx = { log: () => {} };

describe('resource-type-tree', () => {
  it('groups resources by attribute into a root + one child context per type', async () => {
    const { contexts, members } = await plugin.run({ scopeSystemId: 1 }, ctx);
    const exts = contexts.map((c) => c.externalId);
    expect(exts).toContain('type-root');
    expect(exts).toContain('type:Microsoft.Compute/virtualMachines');
    expect(exts).toContain('type:Microsoft.Storage/storageAccounts');
    // type contexts hang off the root
    expect(contexts.find((c) => c.externalId === 'type:Microsoft.Compute/virtualMachines').parentExternalId).toBe('type-root');
    // members land under their type
    expect(
      members.filter((m) => m.contextExternalId === 'type:Microsoft.Compute/virtualMachines').map((m) => m.memberId).sort(),
    ).toEqual(['vm1', 'vm2']);
    expect(members).toContainEqual({ contextExternalId: 'type:Microsoft.Storage/storageAccounts', memberId: 'sa1' });
  });

  it('rejects an unsafe attribute key', async () => {
    await expect(plugin.run({ scopeSystemId: 1, attribute: 'bad key!' }, ctx)).rejects.toThrow(/simple key/);
  });
});
