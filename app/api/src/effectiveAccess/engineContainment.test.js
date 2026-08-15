import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../db/connection.js';
import { getSyncVersion } from '../lib/syncVersion.js';

vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../lib/syncVersion.js', () => ({ getSyncVersion: vi.fn() }));

const { getAncestorNodes, effectiveAccessAtNode } = await import('./engine.js');

// Scope tree:  sub  ⊃ rg ⊃ vm   (propagates)   and   sub ⊃ rgx (BROKEN: propagates=false)
const contains = {
  vm: [{ parent: 'rg', propagates: true }],
  rg: [{ parent: 'sub', propagates: true }],
  rgx: [{ parent: 'sub', propagates: false }],
};
const membership = {}; // no group memberships in this fixture → holders(P) = {P}

// Capability-resource grants: cap @ target, held by `holder`, with effect + propagationScope.
const grants = [
  { cap: 'Contributor', target: 'sub', holder: 'u1', effect: 'allow', scope: 'selfAndDescendants' },
  { cap: 'Reader', target: 'vm', holder: 'u1', effect: 'allow', scope: 'selfAndDescendants' },
  { cap: 'Owner', target: 'sub', holder: 'u1', effect: 'allow', scope: 'self' }, // self-scope at ancestor: must NOT reach vm
];

// The propagating-ancestor rows for a frontier (walks Contains upward).
function ancestorRows(frontier) {
  const parents = new Set();
  for (const c of frontier) for (const e of contains[c] || []) if (e.propagates) parents.add(e.parent);
  return [...parents].map((parent) => ({ parent }));
}
// getHolders: the group ids the frontier principals belong to.
function holderRows(frontier) {
  const gids = new Set();
  for (const p of frontier) for (const g of membership[p] || []) gids.add(g);
  return [...gids].map((gid) => ({ gid }));
}
// gather: capability grants at any ancestor, held by any holder.
function grantRows([ancestorIds, holderArr]) {
  return grants
    .filter((g) => ancestorIds.includes(g.target) && holderArr.includes(g.holder))
    .map((g) => ({ cap: g.cap, target: g.target, holder: g.holder, effect: g.effect, scope: g.scope }));
}

function wire() {
  db.query.mockImplementation((sql, params) => {
    if (sql.includes('ResourceRelationships')) return Promise.resolve({ rows: ancestorRows(params[0]) });
    if (sql.includes('resourceType')) return Promise.resolve({ rows: holderRows(params[0]) });
    if (sql.includes('targetNodeId')) return Promise.resolve({ rows: grantRows(params) });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wire();
  getSyncVersion.mockResolvedValue(1);
});

describe('getAncestorNodes', () => {
  it('walks Contains upward with correct distances', async () => {
    const { depthByNode } = await getAncestorNodes('vm');
    expect(depthByNode.get('vm')).toBe(0);
    expect(depthByNode.get('rg')).toBe(1);
    expect(depthByNode.get('sub')).toBe(2);
  });

  it('stops at an inheritance break (propagates=false)', async () => {
    const { depthByNode } = await getAncestorNodes('rgx');
    expect([...depthByNode.keys()]).toEqual(['rgx']); // never ascends to sub
  });
});

describe('effectiveAccessAtNode', () => {
  it('inherits ancestor grants as Indirect, keeps focus-node grants Direct, drops self-scope-at-ancestor', async () => {
    const r = await effectiveAccessAtNode('vm', 'u1');
    const caps = Object.fromEntries(r.capabilities.map((c) => [c.capabilityId, c.badge]));
    expect(caps.Contributor).toBe('Indirect'); // inherited from sub (distance 2)
    expect(caps.Reader).toBe('Direct'); // declared at vm
    expect(caps.Owner).toBeUndefined(); // self-scope at sub does not reach a descendant
  });

  it('synthesizes a deterministic capability-resource id for the focus node', async () => {
    const r = await effectiveAccessAtNode('vm', 'u1');
    const contributor = r.capabilities.find((c) => c.capabilityId === 'Contributor');
    expect(contributor.capabilityResourceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns nothing for a principal with no reaching grants', async () => {
    const r = await effectiveAccessAtNode('vm', 'nobody');
    expect(r.capabilities).toEqual([]);
  });
});
