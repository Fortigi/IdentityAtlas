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
import { getSyncVersion } from '../lib/syncVersion.js';
import { GROUP_PRINCIPAL_TYPE } from '../lib/principalTypes.js';
import {
  buildInheritedFlatRows, buildInheritedRollupCounts,
  buildInheritedContextCounts, buildInheritedFoldCounts, explainInheritance,
} from './inheritedAccess.js';

const NODE = '11111111-1111-1111-1111-111111111111';
const RES = '22222222-2222-2222-2222-222222222222';
const P1 = '33333333-3333-3333-3333-333333333333';

// One effective-access row: principal P1 has Indirect access on RES via NODE.
const EFF = [{ nodeId: NODE, resourceId: RES, displayName: 'Key Vault', resourceType: 'vault', membershipType: 'Indirect', capabilityId: 'cap1', principalId: P1 }];

// A `built` scope object with a resource scope and no subject scope. The
// generators render each fragment through a per-query binder, so `resource` /
// `subject` are closures returning `{ sql }`; `hasResource` / `hasSubject`
// gate whether the fragment is queried at all.
const BUILT = {
  hasResource: true,
  hasSubject: false,
  resource: () => ({ sql: '(SELECT id FROM "Resources" WHERE 1=1)' }),
  subject: () => ({ sql: null }),
};

// Native pg pool — scopedNodeIds runs `p.query(sql, params)` → [NODE]; with no
// subject scope, no principal query is made.
const makeP = (nodeIds = [NODE]) => ({
  query(sql) {
    if (/FROM "Resources" WHERE id IN/.test(sql)) return Promise.resolve({ rows: nodeIds.map(id => ({ id })) });
    return Promise.resolve({ rows: [] });
  },
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

  it('rolls each holder principal up to its identities for identity rowType', async () => {
    const N = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    effectiveAccessForNodes.mockResolvedValue({ rows: [{ nodeId: N, resourceId: RES, displayName: 'Key Vault', resourceType: 'vault', membershipType: 'Indirect', capabilityId: 'cap1', principalId: P1 }] });
    db.query.mockImplementation((sql) => {
      if (/FROM "IdentityMembers" im JOIN "Identities"/.test(sql)) return Promise.resolve({ rows: [{ pid: P1, id: 'ident-1', displayName: 'Alice Person', email: 'alice@x' }] });
      if (/FROM "Principals" WHERE id = ANY/.test(sql)) return Promise.resolve({ rows: [{ id: P1, displayName: 'Alice', email: 'a@x', principalType: 'User', extendedAttributes: null }] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: N, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });
    const out = await buildInheritedFlatRows(makeP([N]), BUILT, 'identity', []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ resourceId: RES, memberId: 'ident-1', memberDisplayName: 'Alice Person', memberType: 'Identity', inheritedPrincipalId: P1 });
  });

  it('selects and carries dynamic (non displayName/email) subject columns', async () => {
    const N = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    effectiveAccessForNodes.mockResolvedValue({ rows: [{ nodeId: N, resourceId: RES, displayName: 'Key Vault', resourceType: 'vault', membershipType: 'Indirect', capabilityId: 'cap1', principalId: P1 }] });
    let principalSql = '';
    db.query.mockImplementation((sql) => {
      if (/FROM "Principals" WHERE id = ANY/.test(sql)) { principalSql = sql; return Promise.resolve({ rows: [{ id: P1, displayName: 'Alice', email: 'a@x', principalType: 'User', extendedAttributes: null, department: 'Eng' }] }); }
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: N, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });
    // displayName/email are dropped from the dynamic set; department is added.
    const out = await buildInheritedFlatRows(makeP([N]), BUILT, 'principal', [{ name: 'department' }, { name: 'displayName' }]);
    expect(principalSql).toContain('"department"');
    expect(out[0].department).toBe('Eng');
  });

  it('returns [] for an unbounded (no resource scope) matrix', async () => {
    expect(await buildInheritedFlatRows(makeP(), { ...BUILT, hasResource: false }, 'principal', [])).toEqual([]);
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

  it('folds a holder onto multiple frontier nodes and de-duplicates holders per cell', async () => {
    const N = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const P2 = '44444444-4444-4444-4444-444444444444';
    effectiveAccessForNodes.mockResolvedValue({ rows: [
      { nodeId: N, resourceId: RES, displayName: 'Key Vault', resourceType: 'vault', membershipType: 'Indirect', capabilityId: 'cap1', principalId: P1 },
      { nodeId: N, resourceId: RES, displayName: 'Key Vault', resourceType: 'vault', membershipType: 'Indirect', capabilityId: 'cap1', principalId: P2 },
    ] });
    db.query.mockImplementation((sql) => {
      if (/WITH RECURSIVE frontier/.test(sql)) return Promise.resolve({ rows: [
        { gv: 'ctx-A', pid: P1 }, { gv: 'ctx-B', pid: P1 }, { gv: 'ctx-A', pid: P2 },
      ] });
      if (/"principalType" AS pt FROM "Principals"/.test(sql)) return Promise.resolve({ rows: [{ id: P1, pt: 'User' }, { id: P2, pt: 'User' }] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: N, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await buildInheritedContextCounts(makeP([N]), BUILT, 'principal', ['ctx-A', 'ctx-B']);
    // ctx-A holds P1 + P2 (distinct = 2); ctx-B holds only P1 (distinct = 1).
    const byGv = Object.fromEntries(r.counts.map((c) => [c.groupValue, c.directCount]));
    expect(byGv).toEqual({ 'ctx-A': 2, 'ctx-B': 1 });
    const totals = Object.fromEntries(r.groupTotals.map((t) => [t.groupValue, t.total]));
    expect(totals).toEqual({ 'ctx-A': 2, 'ctx-B': 1 });
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

  // ── propagationScope: which ancestors actually GRANT the access ────────────
  // `reaches()` is the rule behind the "why does this person have access?" answer.
  // Migration 038 defines propagationScope as self | descendants | selfAndDescendants,
  // Azure-RBAC style: an assignment on the focus node itself only counts when its
  // scope includes `self`, and one on an ancestor only counts when it includes
  // `descendants`. Get it backwards and the explanation names a resource that does
  // not grant the access, or hides the one that does — wrong in both directions and
  // silent in both.
  //
  // Every scope value is asserted by WHICH ids come back, never by how many: a count
  // cannot tell "the right two" from "a different two".

  const chainRow = (id, depth, scope, isSource, extra = {}) => ({
    id, depth, scope, isSource,
    name: `n-${id}`, label: `l-${id}`, rolename: null, effect: null, ...extra,
  });

  it('applies each propagationScope by depth — self at the node, descendants above it', async () => {
    // One fixture, five deliberately different rows. Each is the sole example of its
    // case, so no two are interchangeable and a mutant that mixes them up changes the
    // answer rather than landing on the same list.
    db.query.mockResolvedValue({ rows: [
      chainRow('focus', 0, 'descendants', true),            // on the node, but grants only BELOW it
      chainRow('selfOnly', 1, 'self', true),                // above the node, grants only at itself
      chainRow('both', 2, 'selfAndDescendants', true, { rolename: 'Owner', effect: 'Allow' }),
      chainRow('noScope', 3, null, true),                   // unset scope propagates (038 default)
      chainRow('tooHigh', 4, 'descendants', false),         // would reach, but carries no assignment
    ] });

    const r = await explainInheritance('focus', 'cap1', P1);

    // Only the two whose scope reaches the focus AND that carry an assignment.
    expect(r.sources.map((s) => s.id)).toEqual(['both', 'noScope']);
    // `tooHigh` is above the deepest source, so it is not part of the explanation.
    expect(r.chain.map((c) => c.id)).toEqual(['noScope', 'both', 'selfOnly', 'focus']);
    expect(r.chain.map((c) => c.isSource)).toEqual([true, true, false, false]);
  });

  it.each([
    ['self', 'the assignment applies at the node itself'],
    ['selfAndDescendants', 'the assignment applies at the node and below'],
    [null, 'an unset scope defaults to applying at the node'],
  ])('counts a depth-0 assignment scoped %s as the source', async (scope) => {
    // The negative direction is covered above (a depth-0 row scoped `descendants` is
    // NOT a source). These are its counterparts: without them, a mutant that makes
    // the depth-0 test always-false would leave that assertion still passing.
    db.query.mockResolvedValue({ rows: [chainRow('focus', 0, scope, true)] });

    const r = await explainInheritance('focus', 'cap1', P1);

    expect(r.sources.map((s) => s.id)).toEqual(['focus']);
    expect(r.chain.map((c) => c.isSource)).toEqual([true]);
  });

  it('explains nothing above the focus when no assignment reaches it', async () => {
    // No source => maxDepth falls back to 0, so the chain is the focus alone rather
    // than the whole containment path. An off-by-one there would leak ancestors into
    // an explanation that has nothing to explain.
    db.query.mockResolvedValue({ rows: [
      chainRow('focus', 0, 'descendants', true),   // grants below, not here
      chainRow('parent', 1, 'self', true),         // grants at itself, not here
    ] });

    const r = await explainInheritance('focus', 'cap1', P1);

    expect(r.sources).toEqual([]);
    expect(r.chain.map((c) => c.id)).toEqual(['focus']);
  });

  it('reports the role and effect of each source, not just its identity', async () => {
    db.query.mockResolvedValue({ rows: [
      chainRow('sub', 1, 'descendants', true, { rolename: 'Owner', effect: 'Allow' }),
      chainRow('mg', 2, 'selfAndDescendants', true, { rolename: 'Reader', effect: 'Deny' }),
    ] });

    const r = await explainInheritance('focus', 'cap1', P1);

    // Distinct role AND effect per source: a mutant that reads either field off the
    // wrong row changes one of these pairs.
    expect(r.sources.map((s) => [s.id, s.role, s.effect])).toEqual([
      ['sub', 'Owner', 'Allow'],
      ['mg', 'Reader', 'Deny'],
    ]);
  });
});

// ── Group principals are containers, not holders ────────────────────────────
// A group is how access is delivered, not someone who has it. Counting one as a
// holder double-counts the access — once for the group, once for each member who
// already appears through it — and puts a group's name in a list of people. Every
// builder therefore drops group principals, at three separate sites.
//
// Nothing exercised any of them before these tests: every existing fixture is a
// `User`, so the filters passed everything through and deleting them changed no
// result. Each test below mixes a group in with users and asserts WHICH ids
// survive, so a dropped or inverted filter changes the answer.
describe('group principals are excluded from holder rows and counts', () => {
  const P2 = '44444444-4444-4444-4444-444444444444';
  const GRP = '55555555-5555-5555-5555-555555555555';
  const GHOST = '66666666-6666-6666-6666-666666666666';

  // The effective-access cache is module-level and keyed by a hash of the scope's
  // node ids, so each test scopes to its own node or it reads another test's rows.
  const effRow = (node, principalId) => ({
    nodeId: node, resourceId: RES, displayName: 'Key Vault', resourceType: 'vault',
    membershipType: 'Indirect', capabilityId: 'cap1', principalId,
  });

  it('keeps a group, and an unknown principal, out of the flat holder rows', async () => {
    const N = 'aaaaaaa1-0000-0000-0000-000000000001';
    effectiveAccessForNodes.mockResolvedValue({ rows: [
      effRow(N, P1), effRow(N, P2), effRow(N, GRP), effRow(N, GHOST),
    ] });
    db.query.mockImplementation((sql) => {
      if (/FROM "Principals" WHERE id = ANY/.test(sql)) return Promise.resolve({ rows: [
        { id: P1, displayName: 'Alice', email: 'a@x', principalType: 'User', extendedAttributes: null },
        { id: P2, displayName: 'Bob', email: 'b@x', principalType: 'User', extendedAttributes: null },
        { id: GRP, displayName: 'Engineers', email: null, principalType: GROUP_PRINCIPAL_TYPE, extendedAttributes: null },
        // GHOST is deliberately absent: an effective-access row can outlive the
        // principal it names, and reading properties off the missing row would throw.
      ] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: N, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });

    const out = await buildInheritedFlatRows(makeP([N]), BUILT, 'principal', []);

    // Two users in, two rows out — by id, so "the right two" is distinguishable
    // from "some other two".
    expect(out.map((r) => r.memberId)).toEqual([P1, P2]);
    expect(out.map((r) => r.memberDisplayName)).toEqual(['Alice', 'Bob']);
  });

  it('keeps a group out of the rolled-up per-group-value counts', async () => {
    const N = 'aaaaaaa1-0000-0000-0000-000000000002';
    effectiveAccessForNodes.mockResolvedValue({ rows: [
      effRow(N, P1), effRow(N, P2), effRow(N, GRP),
    ] });
    db.query.mockImplementation((sql) => {
      // The group shares Engineering with P1, so counting it would read as 2 there
      // while Sales stays at 1 — an asymmetry a per-group assertion can see.
      if (/AS gv FROM "Principals"/.test(sql)) return Promise.resolve({ rows: [
        { id: P1, pt: 'User', gv: 'Engineering' },
        { id: P2, pt: 'User', gv: 'Sales' },
        { id: GRP, pt: GROUP_PRINCIPAL_TYPE, gv: 'Engineering' },
      ] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: N, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });

    const r = await buildInheritedRollupCounts(makeP([N]), BUILT, 'principal', 'department', []);

    const byGv = Object.fromEntries(r.counts.map((c) => [c.groupValue, c.directCount]));
    expect(byGv).toEqual({ Engineering: 1, Sales: 1 });
    expect(Object.fromEntries(r.groupTotals.map((t) => [t.groupValue, t.total])))
      .toEqual({ Engineering: 1, Sales: 1 });
  });

  it('keeps a group out of the frontier-context counts', async () => {
    const N = 'aaaaaaa1-0000-0000-0000-000000000003';
    effectiveAccessForNodes.mockResolvedValue({ rows: [
      effRow(N, P1), effRow(N, P2), effRow(N, GRP),
    ] });
    db.query.mockImplementation((sql) => {
      if (/WITH RECURSIVE frontier/.test(sql)) return Promise.resolve({ rows: [
        { gv: 'ctx-A', pid: P1 }, { gv: 'ctx-A', pid: GRP }, { gv: 'ctx-B', pid: P2 },
      ] });
      if (/"principalType" AS pt FROM "Principals"/.test(sql)) return Promise.resolve({ rows: [
        { id: P1, pt: 'User' }, { id: P2, pt: 'User' }, { id: GRP, pt: GROUP_PRINCIPAL_TYPE },
      ] });
      if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: N, systemId: 7, systemName: 'Azure' }] });
      return Promise.resolve({ rows: [] });
    });

    const r = await buildInheritedContextCounts(makeP([N]), BUILT, 'principal', ['ctx-A', 'ctx-B']);

    // ctx-A would read 2 if the group counted; ctx-B is 1 either way, which is what
    // makes the pair discriminating rather than a single number that could be right
    // for the wrong reason.
    expect(Object.fromEntries(r.counts.map((c) => [c.groupValue, c.directCount])))
      .toEqual({ 'ctx-A': 1, 'ctx-B': 1 });
  });
});

// ── The effective-access cache ──────────────────────────────────────────────
// Effective access is expensive, so it is cached per (sync-version, scope-hash).
// A cache that is wrong is silent in both directions: it serves access that is no
// longer granted, or misses constantly and the matrix crawls. None of this was
// exercised — the tests all used one node id and never called twice — so the key
// could have been built from anything and every test still passed.
//
// The cache is module-level, so these tests cannot reset it; each uses its own
// node ids and counts engine invocations instead.
describe('effective-access caching', () => {
  const rowsFor = (node) => ({ rows: [{
    nodeId: node, resourceId: RES, displayName: 'Key Vault', resourceType: 'vault',
    membershipType: 'Indirect', capabilityId: 'cap1', principalId: P1,
  }] });

  const stubDb = (node) => db.query.mockImplementation((sql) => {
    if (/FROM "Principals" WHERE id = ANY/.test(sql)) return Promise.resolve({ rows: [{ id: P1, displayName: 'Alice', email: 'a@x', principalType: 'User', extendedAttributes: null }] });
    if (/FROM "Resources" r LEFT JOIN "Systems"/.test(sql)) return Promise.resolve({ rows: [{ id: node, systemId: 7, systemName: 'Azure' }] });
    return Promise.resolve({ rows: [] });
  });

  it('treats the same scope as one entry however the node ids are ordered', async () => {
    // Two nodes, requested in both orders. The key sorts them, so this is one
    // scope and must cost one engine call — drop the sort and the second request
    // computes the identical answer again, permanently halving the hit rate for
    // any scope the database returns in a different order.
    const A = 'bbbbbbb1-0000-0000-0000-00000000000a';
    const B = 'bbbbbbb1-0000-0000-0000-00000000000b';
    effectiveAccessForNodes.mockResolvedValue(rowsFor(A));
    stubDb(A);

    await buildInheritedFlatRows(makeP([A, B]), BUILT, 'principal', []);
    await buildInheritedFlatRows(makeP([B, A]), BUILT, 'principal', []);

    expect(effectiveAccessForNodes).toHaveBeenCalledTimes(1);
  });

  it('serves a repeated scope from the cache instead of recomputing it', async () => {
    const N = 'bbbbbbb1-0000-0000-0000-00000000000c';
    effectiveAccessForNodes.mockResolvedValue(rowsFor(N));
    stubDb(N);

    const first = await buildInheritedFlatRows(makeP([N]), BUILT, 'principal', []);
    const second = await buildInheritedFlatRows(makeP([N]), BUILT, 'principal', []);

    expect(effectiveAccessForNodes).toHaveBeenCalledTimes(1);
    // Same answer, not merely the same count — a cache that returned nothing on a
    // hit would also satisfy the call count.
    expect(second.map((r) => r.memberId)).toEqual(first.map((r) => r.memberId));
    expect(second).toHaveLength(1);
  });

  it('stops serving pre-crawl access once the sync version moves', async () => {
    // The invalidation that matters: a crawl bumps the sync version, and access
    // resolved before it must not be handed out afterwards. Without the version in
    // the key, a revoked grant keeps appearing in the matrix until the process
    // restarts — the cache would have no way to know the data underneath changed.
    const N = 'bbbbbbb1-0000-0000-0000-00000000000d';
    effectiveAccessForNodes.mockResolvedValue(rowsFor(N));
    stubDb(N);

    getSyncVersion.mockResolvedValue(41);
    await buildInheritedFlatRows(makeP([N]), BUILT, 'principal', []);
    getSyncVersion.mockResolvedValue(42);
    await buildInheritedFlatRows(makeP([N]), BUILT, 'principal', []);

    expect(effectiveAccessForNodes).toHaveBeenCalledTimes(2);
  });

  it('still answers when the sync version cannot be read', async () => {
    // getSyncVersion failing must degrade to one shared bucket, not take the whole
    // matrix down with it.
    const N = 'bbbbbbb1-0000-0000-0000-00000000000e';
    effectiveAccessForNodes.mockResolvedValue(rowsFor(N));
    stubDb(N);
    getSyncVersion.mockRejectedValue(new Error('no db'));

    const out = await buildInheritedFlatRows(makeP([N]), BUILT, 'principal', []);

    expect(out.map((r) => r.memberId)).toEqual([P1]);
  });
});
