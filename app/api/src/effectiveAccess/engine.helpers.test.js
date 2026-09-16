import { describe, it, expect } from 'vitest';
import {
  grantReach,
  buildAce,
  groupAtNodeAces,
  resolveAtNodeCapabilities,
  atNodeTruncation,
  groupForNodeGrants,
  emitNodeRows,
} from './engine.helpers.js';
import { capabilityResourceId } from '../lib/capabilityId.js';

// A tiny stand-in for the real resolution policy: any ACE marked allow wins, and the decisive
// ACE drives the badge. Matches the shape engine helpers consume (resolve → { effective,
// decisiveAce }).
const allowPolicy = {
  resolve(aces) {
    const allows = aces.filter((a) => a.effect === 'allow');
    if (allows.length === 0) return { effective: 'none', decisiveAce: null };
    // Prefer a direct (explicit, no group hop) ACE so the badge reads Direct when one exists.
    const decisive = allows.find((a) => a.explicit && !a.viaGroupId) ?? allows[0];
    return { effective: 'allow', decisiveAce: decisive };
  },
};

// Degenerate policy: allow but with no decisive ACE — exercises the null-decisiveAce fallback
// (badge → null in the at-node path, membershipType → 'Indirect' in the for-nodes path).
const allowNoDecisivePolicy = {
  resolve(aces) {
    const effective = aces.some((a) => a.effect === 'allow') ? 'allow' : 'none';
    return { effective, decisiveAce: null };
  },
};

// depthByNode: vm=0 (focus), rg=1, sub=2 — used across reach tests.
const depthByNode = new Map([
  ['vm', 0],
  ['rg', 1],
  ['sub', 2],
]);

describe('grantReach', () => {
  it('returns null for a target outside the collected tree', () => {
    expect(grantReach(depthByNode, 'unknown', 'selfAndDescendants')).toBeNull();
  });

  it('at the focus node, self and selfAndDescendants reach; descendants does not', () => {
    expect(grantReach(depthByNode, 'vm', 'self')).toEqual({ distance: 0, atFocus: true });
    expect(grantReach(depthByNode, 'vm', 'selfAndDescendants')).toEqual({ distance: 0, atFocus: true });
    expect(grantReach(depthByNode, 'vm', 'descendants')).toBeNull();
  });

  it('at an ancestor, descendants and selfAndDescendants reach; self does not', () => {
    expect(grantReach(depthByNode, 'sub', 'descendants')).toEqual({ distance: 2, atFocus: false });
    expect(grantReach(depthByNode, 'sub', 'selfAndDescendants')).toEqual({ distance: 2, atFocus: false });
    expect(grantReach(depthByNode, 'sub', 'self')).toBeNull();
  });

  it('defaults a missing scope to selfAndDescendants', () => {
    expect(grantReach(depthByNode, 'sub', undefined)).toEqual({ distance: 2, atFocus: false });
    expect(grantReach(depthByNode, 'vm', null)).toEqual({ distance: 0, atFocus: true });
  });
});

describe('buildAce', () => {
  it('passes fields through and defaults a missing effect to allow', () => {
    expect(buildAce('deny', 2, false, 'gA')).toEqual({ effect: 'deny', distance: 2, explicit: false, viaGroupId: 'gA' });
    expect(buildAce(undefined, 0, true, null)).toEqual({ effect: 'allow', distance: 0, explicit: true, viaGroupId: null });
  });
});

describe('groupAtNodeAces', () => {
  it('groups reaching grants by capability, drops non-reaching, and sets viaGroupId', () => {
    const rows = [
      { cap: 'Reader', target: 'vm', holder: 'u1', effect: 'allow', scope: 'selfAndDescendants' }, // direct at focus
      { cap: 'Reader', target: 'sub', holder: 'gA', effect: 'allow', scope: 'selfAndDescendants' }, // second Reader ACE → same key
      { cap: 'Contributor', target: 'sub', holder: 'gA', effect: 'allow', scope: 'selfAndDescendants' }, // inherited via group
      { cap: 'Owner', target: 'sub', holder: 'u1', effect: 'allow', scope: 'self' }, // self at ancestor → drop
      { cap: 'Ghost', target: 'gone', holder: 'u1', effect: 'allow', scope: 'selfAndDescendants' }, // outside tree → drop
    ];
    const byCap = groupAtNodeAces(rows, depthByNode, 'u1');
    expect([...byCap.keys()].sort()).toEqual(['Contributor', 'Reader']);
    expect(byCap.get('Reader')).toHaveLength(2); // both Reader ACEs collected under one key
    expect(byCap.get('Reader')[0]).toEqual({ effect: 'allow', distance: 0, explicit: true, viaGroupId: null });
    expect(byCap.get('Reader')[1]).toEqual({ effect: 'allow', distance: 2, explicit: false, viaGroupId: 'gA' });
    expect(byCap.get('Contributor')[0]).toEqual({ effect: 'allow', distance: 2, explicit: false, viaGroupId: 'gA' });
  });
});

describe('resolveAtNodeCapabilities', () => {
  it('drops none results, badges the rest, and sorts by capabilityId', () => {
    const byCap = new Map([
      ['Reader', [{ effect: 'allow', distance: 0, explicit: true, viaGroupId: null }]],
      ['Contributor', [{ effect: 'allow', distance: 2, explicit: false, viaGroupId: 'gA' }]],
      ['Empty', [{ effect: 'deny', distance: 0, explicit: true, viaGroupId: null }]],
    ]);
    const caps = resolveAtNodeCapabilities(byCap, allowPolicy, 'vm');
    expect(caps.map((c) => c.capabilityId)).toEqual(['Contributor', 'Reader']); // sorted, Empty dropped
    const reader = caps.find((c) => c.capabilityId === 'Reader');
    expect(reader.badge).toBe('Direct');
    expect(reader.capabilityResourceId).toBe(capabilityResourceId('vm', 'Reader'));
    expect(caps.find((c) => c.capabilityId === 'Contributor').badge).toBe('Indirect');
  });

  it('badge is null when the policy resolves allow without a decisive ACE', () => {
    const byCap = new Map([['Reader', [{ effect: 'allow', distance: 0, explicit: true, viaGroupId: null }]]]);
    const caps = resolveAtNodeCapabilities(byCap, allowNoDecisivePolicy, 'vm');
    expect(caps).toHaveLength(1);
    expect(caps[0].badge).toBeNull();
  });
});

describe('atNodeTruncation', () => {
  it('is null when nothing was capped', () => {
    expect(atNodeTruncation(false, new Set(['a']), false, new Map([['a', 0]]))).toBeNull();
  });

  it('reports only the capped side(s)', () => {
    expect(atNodeTruncation(true, new Set(['a', 'b']), false, new Map([['a', 0]]))).toEqual({
      holders: 2,
      ancestors: undefined,
    });
    expect(atNodeTruncation(false, new Set(['a']), true, new Map([['a', 0], ['b', 1]]))).toEqual({
      holders: undefined,
      ancestors: 2,
    });
  });
});

describe('groupForNodeGrants', () => {
  it('groups reaching grants by capability+holder and drops non-reaching', () => {
    const grantRows = [
      { cap: 'Owner', target: 'sub', rolename: 'Owner', rtype: 'AzureRole', holder: 'u1', effect: 'allow', scope: 'selfAndDescendants' },
      { cap: 'Owner', target: 'vm', rolename: 'Owner', rtype: 'AzureRole', holder: 'u1', effect: 'allow', scope: 'selfAndDescendants' },
      { cap: 'Owner', target: 'sub', rolename: 'Owner', rtype: 'AzureRole', holder: 'u1', effect: 'allow', scope: 'self' }, // self at ancestor → drop
    ];
    const byCapHolder = groupForNodeGrants(grantRows, depthByNode);
    expect([...byCapHolder.keys()]).toEqual(['Owner u1']);
    const entry = byCapHolder.get('Owner u1');
    expect(entry).toMatchObject({ cap: 'Owner', rolename: 'Owner', rtype: 'AzureRole', holder: 'u1' });
    expect(entry.aces).toHaveLength(2); // both reaching grants collected, self-at-ancestor dropped
    expect(entry.aces.every((a) => a.viaGroupId === null)).toBe(true);
  });
});

describe('emitNodeRows', () => {
  const byCapHolder = new Map([
    ['Owner u1', { cap: 'Owner', rolename: 'Owner', rtype: 'AzureRole', holder: 'u1', aces: [{ effect: 'allow', distance: 0, explicit: true, viaGroupId: null }] }],
    ['Reader u2', { cap: 'Reader', rolename: null, rtype: 'AzureRole', holder: 'u2', aces: [{ effect: 'allow', distance: 2, explicit: false, viaGroupId: null }] }],
    ['None u3', { cap: 'None', rolename: 'None', rtype: 'AzureRole', holder: 'u3', aces: [{ effect: 'deny', distance: 0, explicit: true, viaGroupId: null }] }],
  ]);

  it('emits one row per resolving group with label + deterministic id and drops none', () => {
    const rows = emitNodeRows(byCapHolder, allowPolicy, 'kv', { name: 'MyVault', label: 'Res' });
    expect(rows).toHaveLength(2); // None dropped
    const owner = rows.find((r) => r.principalId === 'u1');
    expect(owner.displayName).toBe('Owner @ Res: MyVault');
    expect(owner.membershipType).toBe('Direct');
    expect(owner.resourceId).toBe(capabilityResourceId('kv', 'Owner'));
    expect(owner.nodeId).toBe('kv');
    const reader = rows.find((r) => r.principalId === 'u2');
    expect(reader.membershipType).toBe('Indirect');
  });

  it('falls back to the node id and cap when meta and rolename are absent', () => {
    const rows = emitNodeRows(byCapHolder, allowPolicy, 'kv', undefined);
    const reader = rows.find((r) => r.principalId === 'u2');
    expect(reader.displayName).toBe('Reader @ kv'); // no label, rolename null → cap name + node id
  });

  it('badges Indirect when the policy resolves allow without a decisive ACE', () => {
    const rows = emitNodeRows(byCapHolder, allowNoDecisivePolicy, 'kv', { name: 'MyVault', label: 'Res' });
    expect(rows.every((r) => r.membershipType === 'Indirect')).toBe(true);
  });
});
