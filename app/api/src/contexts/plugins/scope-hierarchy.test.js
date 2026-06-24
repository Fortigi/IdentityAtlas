import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../../db/connection.js';

vi.mock('../../db/connection.js', () => ({ query: vi.fn() }));
const { default: plugin } = await import('./scope-hierarchy.js');

// MG → Sub → RG → Resource (all propagating).
const nodes = [
  { id: 'mg',  name: 'MG',  rtype: 'AzureManagementGroup' },
  { id: 'sub', name: 'Sub', rtype: 'AzureSubscription' },
  { id: 'rg',  name: 'RG',  rtype: 'AzureResourceGroup' },
  { id: 'res', name: 'Res', rtype: 'AzureResource' },
];
const edges = [
  { parent: 'mg',  child: 'sub' },
  { parent: 'sub', child: 'rg' },
  { parent: 'rg',  child: 'res' },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockImplementation((sql) => {
    if (sql.includes('ResourceRelationships')) return Promise.resolve({ rows: edges });
    if (sql.includes('FROM "Resources"')) return Promise.resolve({ rows: nodes });
    return Promise.resolve({ rows: [] });
  });
});

const ctx = { log: () => {} };

describe('scope-hierarchy', () => {
  it('full depth (leafResourceTypes empty): every resource is its own context node', async () => {
    const { contexts, members } = await plugin.run({ scopeSystemId: 1 }, ctx);
    const byExt = Object.fromEntries(contexts.map((c) => [c.externalId, c]));
    expect(byExt['scope-root']).toBeTruthy();
    expect(byExt['mg'].parentExternalId).toBe('scope-root');
    expect(byExt['sub'].parentExternalId).toBe('mg');
    expect(byExt['rg'].parentExternalId).toBe('sub');
    expect(byExt['res'].parentExternalId).toBe('rg');
    expect(members).toEqual([]);
  });

  it('stops at a leaf type: descendants become members, not nodes', async () => {
    const { contexts, members } = await plugin.run({ scopeSystemId: 1, leafResourceTypes: ['AzureResourceGroup'] }, ctx);
    const exts = contexts.map((c) => c.externalId);
    expect(exts).toContain('rg');      // resource group is the leaf node
    expect(exts).not.toContain('res'); // the resource is NOT its own node
    expect(members).toContainEqual({ contextExternalId: 'rg', memberId: 'res' });
  });
});
