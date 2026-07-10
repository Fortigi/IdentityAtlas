// Tests for the scoring-pass functions extracted from runScoring(). Each pass
// is now separately importable, so we exercise it in isolation with fake inputs
// (or a mocked DB for the two passes that read/write the database).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection.js', () => ({ query: vi.fn(), queryOne: vi.fn(), tx: vi.fn() }));
import * as db from '../db/connection.js';
import {
  scoreResourceStructural, resolveLastSignIn, buildSubtreeCounts,
  analyzeMembershipForPrincipal, propagateInherited,
  scoreAllResources, scoreAllPrincipals, analyzeMembership, propagateRisk,
  loadScoringData, assembleAndPersist,
} from './engine.js';

const noop = async () => {};

// ─── Pure layer helpers ───────────────────────────────────────────────────

describe('scoreResourceStructural', () => {
  it('sums structural signals: no description + role-assignable', () => {
    const s = scoreResourceStructural({ description: '', extendedAttributes: { isAssignableToRole: true } });
    expect(s.structuralScore).toBe(18); // no description (+3) + role-assignable (+15)
    expect(s.structuralReasons).toHaveLength(2);
  });
  it('flags a mail-enabled security group', () => {
    const s = scoreResourceStructural({ description: 'ok', extendedAttributes: { mailEnabled: true, securityEnabled: true } });
    expect(s.structuralScore).toBe(3);
  });
  it('caps at CAP_STRUCTURAL (25)', () => {
    const s = scoreResourceStructural({ description: '', extendedAttributes: { isAssignableToRole: true, mailEnabled: 'true', securityEnabled: 'true', membershipRuleProcessingState: 'On' } });
    expect(s.structuralScore).toBe(24); // 3+15+3+3 = 24, under cap
  });
});

describe('resolveLastSignIn', () => {
  it('prefers the activity aggregate, then falls back to ext-attrs', () => {
    expect(resolveLastSignIn({ lastSignInDateTime: 'A' }, {})).toBe('A');
    expect(resolveLastSignIn({ lastSuccessfulSignInDateTime: 'B' }, {})).toBe('B');
    expect(resolveLastSignIn(null, { lastSignInDateTime: 'C' })).toBe('C');
    expect(resolveLastSignIn(null, { signInActivity: { lastSignInDateTime: 'D' } })).toBe('D');
    expect(resolveLastSignIn(null, {})).toBeFalsy();
  });
});

describe('buildSubtreeCounts', () => {
  it('BFS-counts each principal\'s org subtree', () => {
    const principalState = new Map([['m1', {}], ['a', {}], ['b', {}], ['c', {}]]);
    const directReports = new Map([['m1', new Set(['a', 'b'])], ['a', new Set(['c'])]]);
    const st = buildSubtreeCounts(principalState, directReports, true);
    expect(st.get('m1')).toBe(3); // a, b, c
    expect(st.get('a')).toBe(1);  // c
    expect(st.get('b')).toBe(0);
  });
  it('returns an empty map when hierarchy is unavailable', () => {
    expect(buildSubtreeCounts(new Map([['a', {}]]), new Map(), false).size).toBe(0);
  });
});

describe('analyzeMembershipForPrincipal', () => {
  it('adds +15 for membership of a high-risk group', () => {
    const state = { ownCount: 0, membershipScore: 0, membershipReasons: [] };
    analyzeMembershipForPrincipal('p1', state, {
      principalMemberships: new Map([['p1', new Set(['r1'])]]),
      resourceState: new Map([['r1', { directScore: 90, row: { displayName: 'Admins' } }]]),
      directReports: new Map(), hierarchyAvailable: false, principalState: new Map(), subtreeCount: new Map(),
    });
    expect(state.membershipScore).toBe(15);
    expect(state.membershipReasons[0]).toContain('high-risk group');
  });
});

describe('propagateInherited', () => {
  it('each target inherits `factor` of its riskiest neighbour', () => {
    const targetState = new Map([['p1', { propagatedScore: 0, propagatedReasons: [] }]]);
    propagateInherited(
      targetState,
      new Map([['p1', new Set(['r1'])]]),
      new Map([['r1', 40]]),
      new Map([['r1', { row: { displayName: 'Admins' } }]]),
      0.30, 'group');
    expect(targetState.get('p1').propagatedScore).toBe(12); // round(40 × 0.30)
    expect(targetState.get('p1').propagatedReasons[0]).toContain('riskiest group');
  });
});

// ─── Pass wrappers (fake data + fake progress reporter, no DB) ──────────────

describe('scoreAllResources / scoreAllPrincipals', () => {
  it('scores every resource row into the returned Map', async () => {
    const data = {
      resources: { rows: [{ id: 'r1', displayName: 'X', description: 'x', extendedAttributes: {} }] },
      groupClassifiers: [], memberCountMap: new Map(), ownerCountMap: new Map(), totalEntities: 1,
    };
    const rs = await scoreAllResources(data, noop);
    expect(rs.get('r1').directScore).toBe(0);
  });
  it('scores every principal row into the returned Map', async () => {
    const data = {
      principals: { rows: [{ id: 'p1', extendedAttributes: {} }] }, resources: { rows: [] },
      userClassifiers: [], agentClassifiers: [], principalOwnerships: new Map(),
      hierarchyAvailable: false, directReports: new Map(), principalMemberships: new Map(),
      principalActivity: new Map(), totalEntities: 1,
    };
    const ps = await scoreAllPrincipals(data, noop);
    expect(ps.get('p1')).toBeDefined();
  });
});

describe('analyzeMembership (pass 3)', () => {
  it('applies the high-risk-group signal across the principal set', async () => {
    const principalState = new Map([['p1', { ownCount: 0, membershipScore: 0, membershipReasons: [] }]]);
    const resourceState = new Map([['r1', { directScore: 90, row: { displayName: 'Admins' } }]]);
    const data = { principalMemberships: new Map([['p1', new Set(['r1'])]]), directReports: new Map(), hierarchyAvailable: false };
    await analyzeMembership(principalState, resourceState, data, noop);
    expect(principalState.get('p1').membershipScore).toBe(15);
  });
});

describe('propagateRisk (pass 4)', () => {
  it('propagates a group\'s pre-score down to its member', async () => {
    const resourceState = new Map([['r1', { directScore: 80, membershipScore: 0, structuralScore: 0, propagatedScore: 0, propagatedReasons: [], row: { displayName: 'Admins' } }]]);
    const principalState = new Map([['p1', { directScore: 0, membershipScore: 0, structuralScore: 0, propagatedScore: 0, propagatedReasons: [], row: { displayName: 'Bob' } }]]);
    const data = { principalMemberships: new Map([['p1', new Set(['r1'])]]), resourceMembers: new Map([['r1', new Set(['p1'])]]) };
    await propagateRisk(resourceState, principalState, data, noop);
    expect(principalState.get('p1').propagatedScore).toBe(12); // round(round(0.5×80) × 0.30)
    expect(resourceState.get('r1').propagatedScore).toBe(0);   // member's pre-score is 0
  });
});

// ─── DB-boundary passes (mocked connection) ─────────────────────────────────

describe('loadScoringData', () => {
  it('loads classifiers + builds the membership/owner indexes', async () => {
    db.queryOne.mockResolvedValue({ id: 'c1', classifiers: { groupClassifiers: [{ id: 'a', score: 80, patterns: ['admin'] }], userClassifiers: [], agentClassifiers: [] } });
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM "Principals"')) return Promise.resolve({ rows: [{ id: 'p1', managerId: 'm1' }, { id: 'm1', managerId: null }] });
      if (sql.includes('PrincipalActivity')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM "Resources"')) return Promise.resolve({ rows: [{ id: 'r1' }] });
      // Ownership now traverses GroupOwnership → HasOwnership (migration 046).
      if (sql.includes('HasOwnership')) return Promise.resolve({ rows: [] });
      if (sql.includes('COUNT') && sql.includes("'Direct'")) return Promise.resolve({ rows: [{ rid: 'r1', cnt: 3 }] });
      if (sql.includes("'Direct'")) return Promise.resolve({ rows: [{ pid: 'p1', rid: 'r1' }] });
      return Promise.resolve({ rows: [] });
    });
    const data = await loadScoringData('c1', noop);
    expect(data.totalEntities).toBe(3);           // 2 principals + 1 resource
    expect(data.groupClassifiers).toHaveLength(1);
    expect(data.hierarchyAvailable).toBe(true);   // m1 has a direct report
    expect(data.memberCountMap.get('r1')).toBe(3);
    expect(data.principalMemberships.get('p1').has('r1')).toBe(true);
  });
  it('throws when no classifier set exists', async () => {
    db.queryOne.mockResolvedValue(null);
    await expect(loadScoringData(null, noop)).rejects.toThrow(/classifier set/);
  });
});

describe('assembleAndPersist', () => {
  it('bulk-inserts rows inside a transaction and marks the run complete', async () => {
    const client = { query: vi.fn().mockResolvedValue({}) };
    db.tx.mockImplementation(async (cb) => cb(client));
    const s = { directScore: 80, membershipScore: 10, structuralScore: 5, propagatedScore: 0, matches: [], directReasons: [], membershipReasons: [], structuralReasons: [], propagatedReasons: [] };
    const updates = [];
    await assembleAndPersist(new Map([['r1', s]]), new Map(), 1, async (f) => updates.push(f));
    expect(client.query).toHaveBeenCalled();
    expect(client.query.mock.calls.some(c => /DELETE FROM "RiskScores"/.test(c[0]))).toBe(true);
    expect(client.query.mock.calls.some(c => /INSERT INTO "RiskScores"/.test(c[0]))).toBe(true);
    expect(updates.some(u => u.status === 'completed' && u.pct === 100)).toBe(true);
  });
});
