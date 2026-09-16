// Tests for the pure helpers extracted from engine.js (index builders +
// membership-analysis scoring signals). No DB — direct unit tests.
import { describe, it, expect } from 'vitest';
import {
  indexDirectReports, indexMemberships, indexOwnerships, countSubtree,
  scoreBroadAccess, findHighRiskMembership, scoreHighRiskMembership,
  scoreOrgSubtree, scoreHighRiskReports, scoreHierarchySignals,
} from './engine.helpers.js';

const newState = () => ({ membershipScore: 0, membershipReasons: [] });

// ─── Index builders ───────────────────────────────────────────────────

describe('indexDirectReports', () => {
  it('maps each manager to the set of their report ids', () => {
    const { directReports, hierarchyAvailable } = indexDirectReports([
      { id: 'a', managerId: 'm1' },
      { id: 'b', managerId: 'm1' },
      { id: 'm1', managerId: null },
    ]);
    expect(hierarchyAvailable).toBe(true);
    expect([...directReports.get('m1')].sort()).toEqual(['a', 'b']);
  });
  it('reports no hierarchy when managerId is empty across the board', () => {
    const { directReports, hierarchyAvailable } = indexDirectReports([{ id: 'a', managerId: null }]);
    expect(hierarchyAvailable).toBe(false);
    expect(directReports.size).toBe(0);
  });
});

describe('indexMemberships', () => {
  it('builds the bidirectional principal↔resource index', () => {
    const { principalMemberships, resourceMembers } = indexMemberships([
      { pid: 'p1', rid: 'r1' },
      { pid: 'p1', rid: 'r2' },
      { pid: 'p2', rid: 'r1' },
    ]);
    expect([...principalMemberships.get('p1')].sort()).toEqual(['r1', 'r2']);
    expect([...resourceMembers.get('r1')].sort()).toEqual(['p1', 'p2']);
  });
});

describe('indexOwnerships', () => {
  it('maps each principal to the set of owned group ids', () => {
    const own = indexOwnerships([
      { pid: 'p1', rid: 'g1' },
      { pid: 'p1', rid: 'g2' },
    ]);
    expect([...own.get('p1')].sort()).toEqual(['g1', 'g2']);
  });
});

describe('countSubtree', () => {
  const directReports = new Map([['m1', new Set(['a', 'b'])], ['a', new Set(['c'])]]);
  it('BFS-counts reachable reports from the roots', () => {
    expect(countSubtree(directReports.get('m1'), directReports)).toBe(3); // a, b, c
    expect(countSubtree(directReports.get('a'), directReports)).toBe(1);  // c
  });
  it('tolerates a cycle without looping forever', () => {
    const cyclic = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]);
    expect(countSubtree(cyclic.get('a'), cyclic)).toBe(2); // a, b (each seen once)
  });
});

// ─── Membership-analysis scoring signals ──────────────────────────────

describe('scoreBroadAccess', () => {
  it('adds points for >15 groups', () => {
    const s = newState();
    scoreBroadAccess(s, 25); // floor((25-15)/3)*3 = 9
    expect(s.membershipScore).toBe(9);
    expect(s.membershipReasons[0]).toContain('broad access footprint');
  });
  it('caps at +15', () => {
    const s = newState();
    scoreBroadAccess(s, 100);
    expect(s.membershipScore).toBe(15);
  });
  it('no-ops at or below the threshold', () => {
    const s = newState();
    scoreBroadAccess(s, 15);
    expect(s.membershipScore).toBe(0);
    expect(s.membershipReasons).toHaveLength(0);
  });
  it('no-ops when the rounded points are 0 (16 groups)', () => {
    const s = newState();
    scoreBroadAccess(s, 16); // floor((16-15)/3)*3 = 0
    expect(s.membershipScore).toBe(0);
    expect(s.membershipReasons).toHaveLength(0);
  });
});

describe('findHighRiskMembership', () => {
  it('returns the riskiest group with direct score ≥ 70', () => {
    const resourceState = new Map([
      ['r1', { directScore: 75, row: { displayName: 'A' } }],
      ['r2', { directScore: 90, row: { displayName: 'B' } }],
      ['r3', { directScore: 40, row: { displayName: 'C' } }],
    ]);
    const hit = findHighRiskMembership(new Set(['r1', 'r2', 'r3']), resourceState);
    expect(hit.directScore).toBe(90);
  });
  it('returns null when nothing is high-risk', () => {
    const resourceState = new Map([['r1', { directScore: 40, row: {} }]]);
    expect(findHighRiskMembership(new Set(['r1']), resourceState)).toBeNull();
  });
});

describe('scoreHighRiskMembership', () => {
  it('adds +15 once with a reason naming the group', () => {
    const s = newState();
    scoreHighRiskMembership(s, new Set(['r1']), new Map([['r1', { directScore: 90, row: { displayName: 'Admins' } }]]));
    expect(s.membershipScore).toBe(15);
    expect(s.membershipReasons[0]).toContain("high-risk group 'Admins'");
  });
  it('no-ops when no high-risk membership', () => {
    const s = newState();
    scoreHighRiskMembership(s, new Set(['r1']), new Map([['r1', { directScore: 10, row: {} }]]));
    expect(s.membershipScore).toBe(0);
  });
});

describe('scoreOrgSubtree', () => {
  it.each([
    [100, 15],
    [50, 12],
    [25, 10],
    [10, 5],
  ])('subtree %i → +%i', (subtree, expected) => {
    const s = newState();
    scoreOrgSubtree(s, subtree);
    expect(s.membershipScore).toBe(expected);
    expect(s.membershipReasons[0]).toContain('org subtree');
  });
  it('no-ops below 10', () => {
    const s = newState();
    scoreOrgSubtree(s, 9);
    expect(s.membershipScore).toBe(0);
  });
});

describe('scoreHighRiskReports', () => {
  const principalState = new Map([
    ['a', { directScore: 90 }],
    ['b', { directScore: 80 }],
    ['c', { directScore: 10 }],
  ]);
  it('adds +5 per high-risk report', () => {
    const s = newState();
    scoreHighRiskReports(s, new Set(['a', 'b', 'c']), principalState);
    expect(s.membershipScore).toBe(10);
    expect(s.membershipReasons[0]).toContain('high-risk direct report');
  });
  it('caps at +15', () => {
    const many = new Map([...'abcd'].map((k) => [k, { directScore: 90 }]));
    const s = newState();
    scoreHighRiskReports(s, new Set(['a', 'b', 'c', 'd']), many);
    expect(s.membershipScore).toBe(15);
  });
  it('no-ops when there are no high-risk reports', () => {
    const s = newState();
    scoreHighRiskReports(s, new Set(['c']), principalState);
    expect(s.membershipScore).toBe(0);
  });
});

describe('scoreHierarchySignals', () => {
  it('combines org-subtree and high-risk-report signals', () => {
    const s = newState();
    const ctx = {
      directReports: new Map([['p1', new Set(['a'])]]),
      principalState: new Map([['a', { directScore: 90 }]]),
      subtreeCount: new Map([['p1', 25]]),
    };
    scoreHierarchySignals(s, 'p1', ctx);
    expect(s.membershipScore).toBe(15); // +10 subtree (25) + 5 one high-risk report
    expect(s.membershipReasons).toHaveLength(2);
  });
});
