import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../db/connection.js';

vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../lib/syncVersion.js', () => ({ getSyncVersion: vi.fn() }));

const { effectiveAccessForNodes } = await import('./engine.js');
const { capabilityResourceId } = await import('../lib/capabilityId.js');

// Containment UP: key vault `kv` ⊂ rg ⊂ sub. Owner is granted at `sub` to u1 (propagates down).
const containsUp = { kv: 'rg', rg: 'sub' };
const grants = [{ cap: 'Owner', target: 'sub', rolename: 'Owner', holder: 'u1', effect: 'allow', scope: 'selfAndDescendants' }];

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockImplementation((sql, params) => {
    if (sql.includes('ResourceRelationships')) {
      const parents = new Set();
      for (const c of params[0]) if (containsUp[c]) parents.add(containsUp[c]);
      return Promise.resolve({ rows: [...parents].map((parent) => ({ parent })) });
    }
    if (sql.includes('AS holder')) {
      const ancestors = params[0];
      return Promise.resolve({ rows: grants.filter((g) => ancestors.includes(g.target)) });
    }
    if (sql.includes('scopeTypeLabel')) {
      return Promise.resolve({ rows: [{ id: 'kv', name: 'MyVault', label: 'Res' }] });
    }
    return Promise.resolve({ rows: [] });
  });
});

describe('effectiveAccessForNodes', () => {
  it('surfaces inherited access at a focus scope as an Indirect row', async () => {
    const { rows } = await effectiveAccessForNodes(['kv']);
    expect(rows).toHaveLength(1);
    expect(rows[0].principalId).toBe('u1');
    expect(rows[0].membershipType).toBe('Indirect');           // inherited from the subscription
    expect(rows[0].displayName).toBe('Owner @ Res: MyVault');
    expect(rows[0].resourceId).toBe(capabilityResourceId('kv', 'Owner'));
  });

  it('returns nothing for an empty focus set', async () => {
    expect((await effectiveAccessForNodes([])).rows).toEqual([]);
  });
});
