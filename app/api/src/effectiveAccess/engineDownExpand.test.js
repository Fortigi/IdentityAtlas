import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../db/connection.js';

vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../lib/syncVersion.js', () => ({ getSyncVersion: vi.fn() }));

const { getDescendantNodes, expandCapabilityDown } = await import('./engine.js');
const { capabilityResourceId } = await import('../lib/capabilityId.js');

// Scope tree:  sub ⊃ rg ⊃ vm   (propagates)   and   sub ⊃ rgx  (BROKEN: propagates=false)
const childrenOf = {
  sub: [{ child: 'rg', propagates: true }, { child: 'rgx', propagates: false }],
  rg: [{ child: 'vm', propagates: true }],
};
const focusRow = { cap: 'Owner', node: 'sub', rtype: 'AzureRoleAssignment', rolename: 'Owner' };
const holders = ['u1', 'g1'];
const names = { rg: 'My RG', vm: 'My VM' };

function wire() {
  db.query.mockImplementation((sql, params) => {
    if (sql.includes('ResourceRelationships')) {
      const frontier = params[0];
      const kids = new Set();
      for (const c of frontier) for (const e of childrenOf[c] || []) if (e.propagates) kids.add(e.child);
      return Promise.resolve({ rows: [...kids].map((child) => ({ child })) });
    }
    if (sql.includes('roleName')) {
      return Promise.resolve({ rows: params[0] === 'owner-at-sub' ? [focusRow] : [] });
    }
    if (sql.includes('AS holder')) {
      return Promise.resolve({ rows: holders.map((h) => ({ holder: h })) });
    }
    if (sql.includes('AS name')) {
      const ids = params[0];
      return Promise.resolve({ rows: ids.filter((id) => names[id]).map((id) => ({ id, name: names[id] })) });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wire();
});

describe('getDescendantNodes', () => {
  it('walks Contains downward with distances, stopping at an inheritance break', async () => {
    const { depthByNode } = await getDescendantNodes('sub');
    expect(depthByNode.get('sub')).toBe(0);
    expect(depthByNode.get('rg')).toBe(1);
    expect(depthByNode.get('vm')).toBe(2);
    expect(depthByNode.has('rgx')).toBe(false); // propagates=false → not descended
  });
});

describe('expandCapabilityDown', () => {
  it('returns null for a non-capability resource (caller falls back to group expansion)', async () => {
    expect(await expandCapabilityDown('not-a-cap')).toBeNull();
  });

  it('fans the capability out to every propagating descendant, holders badged Indirect', async () => {
    const r = await expandCapabilityDown('owner-at-sub');
    expect(r.groups.map((g) => g.displayName).sort()).toEqual(['Owner @ My RG', 'Owner @ My VM']);

    const rgId = capabilityResourceId('rg', 'Owner');
    const vmId = capabilityResourceId('vm', 'Owner');
    expect(r.groups.map((g) => g.groupId).sort()).toEqual([rgId, vmId].sort());

    const forRg = r.memberships.filter((m) => m.groupId === rgId);
    expect(forRg.map((m) => m.memberId).sort()).toEqual(['g1', 'u1']);
    expect(forRg.every((m) => m.membershipType === 'Indirect')).toBe(true);
    expect(r.memberships.length).toBe(4); // 2 descendants × 2 holders
  });
});
