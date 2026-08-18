// The parts of the engine nothing had reached: the cache/telemetry line every resolve emits,
// the group-vs-self distinction behind the Direct badge, DAG de-duplication, and the
// multi-node entrypoint's early exit and truncation roll-up.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSyncVersion } from '../lib/syncVersion.js';

// No inline factory: mocking the module with no second argument picks up the shared manual
// mock at src/db/__mocks__/connection.js. src/db/connectionMock.test.js ratchets the number
// of inline mock factories for that module DOWNWARD, so adding one here would push the count
// up and fail the gate. (It matches on file TEXT, so even quoting such a call in a comment
// counts -- which is why this note describes the pattern instead of showing it.)
vi.mock('../db/connection.js');
vi.mock('../lib/syncVersion.js', () => ({ getSyncVersion: vi.fn() }));
import * as db from '../db/connection.js';

const {
  effectiveAccess, effectiveAccessForNodes, getAncestorNodes, clearCache,
} = await import('./engine.js');

// u1 is a member of group g1; the Contributor grant is held by the GROUP, not by u1.
const membership = { u1: ['g1'] };
const grants = [{ cap: 'Contributor', target: 'sub', holder: 'g1', effect: 'allow', scope: 'selfAndDescendants' }];

function wire({ contains = {}, rows = grants } = {}) {
  db.query.mockImplementation((sql, params) => {
    if (sql.includes('ResourceRelationships')) {
      const parents = new Set();
      for (const c of params[0]) for (const e of contains[c] || []) parents.add(e);
      return Promise.resolve({ rows: [...parents].map((parent) => ({ parent })) });
    }
    if (sql.includes('resourceType')) {
      const gids = new Set();
      for (const p of params[0]) for (const g of membership[p] || []) gids.add(g);
      return Promise.resolve({ rows: [...gids].map((gid) => ({ gid })) });
    }
    if (sql.includes('ResourceAssignments')) {
      // resolveForPrincipalOnResource: grants ON this resource, held by anyone in the
      // holder set (the principal plus their groups). Shape is {holder, effect}.
      return Promise.resolve({
        rows: rows
          .filter((g) => g.target === params[0] && params[1].includes(g.holder))
          .map((g) => ({ holder: g.holder, effect: g.effect })),
      });
    }
    if (sql.includes('displayName')) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
  wire();
  getSyncVersion.mockResolvedValue(1);
});

describe('effectiveAccess - the observability line', () => {
  let logged;
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((s) => logged.push(JSON.parse(s)));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports cacheHit false on the first call and true on the second', async () => {
    // One line per resolve is the documented contract (spec 19), and cacheHit is the only
    // signal that the cache is doing anything at all. Hard-code either value and the line
    // still looks perfectly well-formed.
    await effectiveAccess('sub', 'u1');
    await effectiveAccess('sub', 'u1');

    expect(logged).toHaveLength(2);
    expect(logged[0].cacheHit).toBe(false);
    expect(logged[1].cacheHit).toBe(true);
    expect(logged[0].event).toBe('effective-access-resolve');
    expect(logged[0].focusNode).toBe('sub');
    expect(logged[0].principalId).toBe('u1');
  });

  it('reports truncated as a boolean, not the truncation object', async () => {
    // `!!result.truncated` collapses an object to true. Dropping one `!` inverts it; dropping
    // both leaks the object into a field consumers read as a flag.
    await effectiveAccess('sub', 'u1');
    expect(typeof logged[0].truncated).toBe('boolean');
    expect(logged[0].truncated).toBe(false);
  });

  it('reports a non-negative duration', async () => {
    // Date.now() - started. Read as +, this is ~1.7e12 rather than single digits.
    await effectiveAccess('sub', 'u1');
    expect(logged[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(logged[0].durationMs).toBeLessThan(60_000);
  });
});

describe('resolveForPrincipalOnResource - who actually holds the grant', () => {
  it('marks a grant held by the principals GROUP as not explicit', async () => {
    // explicit drives the Direct badge. Hard-coded true, a grant a user only has through
    // group membership is reported as held directly by them -- the badge says Direct and the
    // group it really came from disappears from the answer.
    const r = await effectiveAccess('sub', 'u1');
    expect(r.effective).toBe('allow');
    expect(r.decisiveAce.explicit).toBe(false);
    expect(r.decisiveAce.viaGroupId).toBe('g1');
  });

  it('marks a grant held by the principal themself as explicit', async () => {
    wire({ rows: [{ cap: 'Contributor', target: 'sub', holder: 'u1', effect: 'allow', scope: 'selfAndDescendants' }] });
    const r = await effectiveAccess('sub', 'u1');
    expect(r.decisiveAce.explicit).toBe(true);
    expect(r.decisiveAce.viaGroupId).toBeNull();
  });
});

describe('getAncestorNodes - DAG de-duplication', () => {
  it('admits a node reached by two different paths exactly once, at its shortest depth', async () => {
    // Diamond: vm -> a and vm -> b, both -> top. Without the "already admitted" check top is
    // re-admitted at the later depth, and on a cyclic graph the walk would not terminate.
    wire({ contains: { vm: ['a', 'b'], a: ['top'], b: ['top'] } });
    const { depthByNode } = await getAncestorNodes('vm');
    expect(depthByNode.get('vm')).toBe(0);
    expect(depthByNode.get('a')).toBe(1);
    expect(depthByNode.get('b')).toBe(1);
    expect(depthByNode.get('top')).toBe(2);
    expect(depthByNode.size).toBe(4);
  });
});

describe('effectiveAccessForNodes', () => {
  it('returns empty for no focus nodes without touching the database', async () => {
    const r = await effectiveAccessForNodes([]);
    expect(r).toEqual({ rows: [], truncated: null });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('treats a null focus list the same way', async () => {
    expect(await effectiveAccessForNodes(null)).toEqual({ rows: [], truncated: null });
  });

  it('de-duplicates repeated focus nodes', async () => {
    await effectiveAccessForNodes(['sub', 'sub']);
    const nameCall = db.query.mock.calls.find(([sql]) => sql.includes('displayName'));
    expect(nameCall[1][0]).toEqual(['sub']);
  });

  it('reports no truncation when nothing truncated', async () => {
    // The paired case below is what stops "always truncated" passing.
    const r = await effectiveAccessForNodes(['sub']);
    expect(r.truncated).toBeNull();
  });

  it('rolls a single truncated node up into the overall result', async () => {
    // One node hitting a cap makes the WHOLE answer incomplete; reporting null there would
    // present a partial result as a complete one.
    wire({ contains: { sub: ['p1'], p1: ['p2'] } });
    const r = await effectiveAccessForNodes(['sub'], { maxDepth: 1 });
    expect(r.truncated).toEqual({ ancestors: true });
  });
});
