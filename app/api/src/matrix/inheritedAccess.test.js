// Unit tests for matrix/inheritedAccess.js — the folded effective-access
// aggregation for the matrix. The effective-access ENGINE and the DB are mocked;
// these pin the JS aggregation (resources/cells/groupSets → counts, flat-row
// emit, inheritance-chain resolution) so the #647 dedup of the near-identical
// rollup builders is verifiable. (#666: 0 floor.)

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../effectiveAccess/engine.js', () => ({ effectiveAccessForNodes: vi.fn() }));
vi.mock('../lib/syncVersion.js', () => ({ getSyncVersion: vi.fn().mockResolvedValue(1) }));
vi.mock('./attrExpr.js', () => ({ resolveAttrExpr: vi.fn(() => ({ attrExpr: 'pr."department"', error: false })) }));
vi.mock('./attributeCut.js', () => ({ visibleKeyExpr: vi.fn(() => 'pr."department"') }));

import * as db from '../db/connection.js';
import { effectiveAccessForNodes } from '../effectiveAccess/engine.js';
import { resolveAttrExpr } from './attrExpr.js';
import {
  buildInheritedFlatRows, buildInheritedRollupCounts,
  buildInheritedContextCounts, buildInheritedFoldCounts, explainInheritance,
} from './inheritedAccess.js';

const NODE = '11111111-1111-1111-1111-111111111111';
const RES = '22222222-2222-2222-2222-222222222222';
const P1 = '33333333-3333-3333-3333-333333333333';

// One effective-access row: principal P1 has Indirect access on RES via NODE.
const EFF = [{ nodeId: NODE, resourceId: RES, displayName: 'Key Vault', resourceType: 'vault', membershipType: 'Indirect', capabilityId: 'cap1', principalId: P1 }];

// A `built` scope object with a resource scope and no subject scope.
const BUILT = { resourceSql: '(SELECT id FROM "Resources" WHERE 1=1)', bindings: {}, subjectSql: null };

// p.request() chain — scopedNodeIds returns [NODE]; no subject query is made.
const makeP = (nodeIds = [NODE]) => ({
  request: () => ({
    input() { return this; },
    query(sql) {
      if (/FROM "Resources" WHERE id IN/.test(sql)) return Promise.resolve({ recordset: nodeIds.map(id => ({ id })) });
      return Promise.resolve({ recordset: [] });
    },
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  effectiveAccessForNodes.mockResolvedValue({ rows: EFF });
  resolveAttrExpr.mockReturnValue({ attrExpr: 'pr."department"', error: false });
});

describe('buildInheritedFlatRows', () => {
  it('emits a flat matrix row per (capability, principal) with the inheritance carried', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM "Principals" WHERE id = ANY/.test(sql)) return Promise.resolve({ rows: [{ id: P1, displayName: 'Alice', email: 'a@x', principalType: 'User', extendedAttributes: null }] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: NODE, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });
    const out = await buildInheritedFlatRows(makeP(), BUILT, 'principal', []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      resourceId: RES, membershipType: 'Indirect', memberId: P1,
      memberDisplayName: 'Alice', systemId: 7, systemName: 'Azure',
      inheritedNodeId: NODE, inheritedPrincipalId: P1, managedByAccessPackage: false,
    });
  });

  it('returns [] for an unbounded (no resource scope) matrix', async () => {
    expect(await buildInheritedFlatRows(makeP(), { ...BUILT, resourceSql: null }, 'principal', [])).toEqual([]);
  });

  it('returns [] when the scope contains no nodes', async () => {
    expect(await buildInheritedFlatRows(makeP([]), BUILT, 'principal', [])).toEqual([]);
  });
});

describe('buildInheritedRollupCounts', () => {
  it('folds holders into per-(resource, group-value) distinct counts', async () => {
    db.query.mockImplementation((sql) => {
      if (/AS gv FROM "Principals"/.test(sql)) return Promise.resolve({ rows: [{ id: P1, pt: 'User', gv: 'Engineering' }] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: NODE, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await buildInheritedRollupCounts(makeP(), BUILT, 'principal', 'department', []);
    expect(r.counts).toEqual([{ resourceId: RES, groupValue: 'Engineering', directCount: 1, governedCount: 0 }]);
    expect(r.groupValues).toEqual(['Engineering']);
    expect(r.groupTotals).toEqual([{ groupValue: 'Engineering', total: 1 }]);
    expect(r.resources[0]).toMatchObject({ resourceId: RES, resourceType: 'vault' });
  });

  it('returns null when the engine yields no effective rows', async () => {
    // Distinct node id → a fresh effective-access cache key (the cache is
    // module-level and keyed by scope hash, so reusing NODE would hit the
    // non-empty result cached by the happy-path test above).
    effectiveAccessForNodes.mockResolvedValue({ rows: [] });
    const freshNode = '99999999-9999-9999-9999-999999999999';
    expect(await buildInheritedRollupCounts(makeP([freshNode]), BUILT, 'principal', 'department', [])).toBeNull();
  });
});

describe('buildInheritedContextCounts', () => {
  it('folds holders onto their frontier context node', async () => {
    db.query.mockImplementation((sql) => {
      if (/WITH RECURSIVE frontier/.test(sql)) return Promise.resolve({ rows: [{ gv: 'ctx-A', pid: P1 }] });
      if (/"principalType" AS pt FROM "Principals"/.test(sql)) return Promise.resolve({ rows: [{ id: P1, pt: 'User' }] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: NODE, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await buildInheritedContextCounts(makeP(), BUILT, 'principal', ['ctx-A']);
    expect(r.counts).toEqual([{ resourceId: RES, groupValue: 'ctx-A', directCount: 1, governedCount: 0 }]);
    expect(r.groupValues).toEqual(['ctx-A']);
  });

  it('returns null without frontier ids', async () => {
    expect(await buildInheritedContextCounts(makeP(), BUILT, 'principal', [])).toBeNull();
  });
});

describe('buildInheritedFoldCounts', () => {
  it('folds holders onto the collapse-aware tuple key', async () => {
    db.query.mockImplementation((sql) => {
      if (/AS gv FROM "Principals"/.test(sql)) return Promise.resolve({ rows: [{ id: P1, gv: 'Engineering|Cloud' }] });
      if (/"principalType" AS pt FROM "Principals"/.test(sql)) return Promise.resolve({ rows: [{ id: P1, pt: 'User' }] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: NODE, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await buildInheritedFoldCounts(makeP(), BUILT, 'principal', [{ attribute: 'department' }], [], []);
    expect(r.counts).toEqual([{ resourceId: RES, groupValue: 'Engineering|Cloud', directCount: 1, governedCount: 0 }]);
    expect(r.groupValues).toEqual(['Engineering|Cloud']);
  });

  it('returns null for identity rowType (not supported)', async () => {
    expect(await buildInheritedFoldCounts(makeP(), BUILT, 'identity', [{ attribute: 'x' }], [], [])).toBeNull();
  });
});

describe('explainInheritance', () => {
  it('returns the source(s) and the containment chain from source to focus', async () => {
    // depth 1 (parent) is the source; depth 0 is the focus.
    db.query.mockResolvedValue({ rows: [
      { id: 'focus', name: 'VM', label: 'Resource', depth: 0, rolename: null, effect: null, scope: null, isSource: false },
      { id: 'sub',   name: 'Subscription', label: 'Subscription', depth: 1, rolename: 'Owner', effect: 'Allow', scope: 'descendants', isSource: true },
    ] });
    const r = await explainInheritance('focus', 'cap1', P1);
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({ id: 'sub', role: 'Owner', effect: 'Allow' });
    // chain runs source (top) → focus (bottom).
    expect(r.chain.map(c => c.id)).toEqual(['sub', 'focus']);
    expect(r.chain[0].isSource).toBe(true);
  });
});
