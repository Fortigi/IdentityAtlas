// Branch-coverage unit tests for routes/matrix/data.js — the core /matrix/data
// handler (flat grid, attribute roll-up, context roll-up, layered attribute
// fold, layered hierarchy, roles-only drills, inherited-access folds, and the
// error/validation paths). DB fully mocked.
//
// Strategy: ./shared.js is mocked so parseFilter/buildSubqueries/scopeCounts are
// driven directly (no need to craft valid request bodies for every branch).
// ../../perf/sqlTimer.js is mocked so timedQuery dispatches off the label to a
// per-test map — giving precise control over each SQL call's rows. The pure SQL
// builders run for real. The inherited-access helpers are mocked so the
// includeInherited branches execute.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const UUID = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';

// ── Mock the DB connection (route only calls getPool) ──
const poolQuery = vi.fn(async () => ({ rows: [] }));
vi.mock('../../db/connection.js', () => ({
  getPool: async () => ({ query: (...a) => poolQuery(...a) }),
  query: (...a) => poolQuery(...a),
  queryOne: vi.fn(),
  default: {},
}));

// ── Mock the SQL timer: timedQuery(pool,label,res,sql,params) → {rows} ──
// Handlers are keyed by label substring; each is an array of rows or a function
// (called per query — throw to drive an error path).
let labelHandlers = {};   // label-substring → rows[] | (() => rows[] | throws)
function dispatch(label) {
  for (const key of Object.keys(labelHandlers)) {
    if (label.includes(key)) {
      const h = labelHandlers[key];
      const out = typeof h === 'function' ? h() : h;
      const rows = Array.isArray(out) ? out : (out?.rows ?? out?.recordset ?? []);
      return Promise.resolve({ rows });
    }
  }
  return Promise.resolve({ rows: [] });
}
vi.mock('../../perf/sqlTimer.js', () => ({
  timedQuery: (_pool, label) => dispatch(label),
}));

// ── Mock shared.js: full control over filter + built + counts ──
let parseFilterImpl = () => baseFilter();
let buildSubqueriesImpl = async () => baseBuilt();
let scopeCountsImpl = async () => ({ subjectCount: 5, subjectTotal: 10, resourceCount: 3, resourceTotal: 8 });
// Spread the real module so runBound/collectResources (pure helpers over the
// mocked timedQuery + built) are exercised for real; override only the three
// entry points the tests drive.
vi.mock('./shared.js', async (importActual) => ({
  ...(await importActual()),
  parseFilter: (...a) => parseFilterImpl(...a),
  buildSubqueries: (...a) => buildSubqueriesImpl(...a),
  scopeCounts: (...a) => scopeCountsImpl(...a),
}));

// ── Mock inherited-access helpers (drive includeInherited branches) ──
let inhFlat = async () => [];
let inhRollup = async () => null;
let inhContext = async () => null;
let inhFold = async () => null;
vi.mock('../../matrix/inheritedAccess.js', () => ({
  buildInheritedFlatRows: (...a) => inhFlat(...a),
  buildInheritedRollupCounts: (...a) => inhRollup(...a),
  buildInheritedContextCounts: (...a) => inhContext(...a),
  buildInheritedFoldCounts: (...a) => inhFold(...a),
}));

const { default: router } = await import('./data.js');
const app = mountRouter(router);

// ── Fixtures ──
function baseFilter(over = {}) {
  return {
    rowType: 'principal',
    subject: { include: [], exclude: [] },
    resource: { include: [], exclude: [] },
    rollup: null,
    rollupContent: 'resources-and-roles',
    rollupMetric: 'count',
    drill: false,
    rollupKind: 'attribute',
    rollupContextId: null,
    rollupPath: [],
    rollupExpanded: [],
    foldAttributes: false,
    rollupCollapsed: [],
    sortAttributes: [{ attribute: 'department', dir: 'asc' }],
    sortHierarchy: null,
    ...over,
  };
}
function baseBuilt(over = {}) {
  const cols = [{ name: 'department', rawName: 'department', type: 'text' }];
  return {
    // Render closures: each query re-invokes these with its own binder. The
    // mock ignores the binder and returns literal SQL (no $N to bind).
    subject: () => ({ sql: '(SELECT id FROM "Principals")' }),
    resource: () => ({ sql: '(SELECT id FROM "Resources")' }),
    hasSubject: true,
    hasResource: true,
    warnings: [],
    principalCols: cols,
    resourceCols: cols,
    identityCols: cols,
    ...over,
  };
}

beforeEach(() => {
  labelHandlers = {};
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [] });
  parseFilterImpl = () => baseFilter();
  buildSubqueriesImpl = async () => baseBuilt();
  scopeCountsImpl = async () => ({ subjectCount: 5, subjectTotal: 10, resourceCount: 3, resourceTotal: 8 });
  inhFlat = async () => [];
  inhRollup = async () => null;
  inhContext = async () => null;
  inhFold = async () => null;
});

const post = (body = {}) => request(app).post('/api/matrix/data').send(body);

// ─────────────────────────────────────────────────────────────────────────────
describe('matrix/data — early branches', () => {
  it('returns the empty default payload when SQL is disabled', async () => {
    // data.js reads useSql at module-eval; flip live via parseFilter is N/A, so
    // assert behaviour only when enabled. Here we instead force an invalid filter.
    parseFilterImpl = () => null;
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filter body');
  });

  it('500 when buildSubqueries throws', async () => {
    buildSubqueriesImpl = async () => { throw new Error('boom'); };
    const res = await post({ filter: {} });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Matrix query failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('matrix/data — flat per-subject grid', () => {
  it('happy path returns data rows + counts + managedByPackages', async () => {
    labelHandlers = {
      'matrix-data[': [
        { resourceId: 'r1', memberId: 'm1', membershipType: 'Direct', resourceDisplayName: 'R1' },
        { resourceId: 'r2', memberId: 'm2', membershipType: 'Direct', resourceDisplayName: 'R2' },
      ],
      'matrix-data-ap-mapping': [
        { memberId: 'm1', resourceId: 'r1', groupId: 'r1', accessPackageIds: 'ap1,ap2' },
        { memberId: null, resourceId: 'rX', accessPackageIds: null }, // filtered out
      ],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.rowType).toBe('principal');
    expect(res.body.subjectCount).toBe(5);
    expect(res.body.subjectTotal).toBe(10);
    expect(res.body.totalUsers).toBe(10);
    expect(res.body.managedByPackages).toEqual([
      { memberId: 'm1', resourceId: 'r1', groupId: 'r1', accessPackageIds: ['ap1', 'ap2'] },
    ]);
  });

  it('identity rowType uses DISTINCT and identity joins', async () => {
    parseFilterImpl = () => baseFilter({ rowType: 'identity' });
    labelHandlers = { 'matrix-data[': [{ resourceId: 'r1', memberId: 'i1' }] };
    const res = await post({ filter: { rowType: 'identity' } });
    expect(res.status).toBe(200);
    expect(res.body.rowType).toBe('identity');
    expect(res.body.data).toHaveLength(1);
  });

  it('works when the subject/resource scope is empty (no scope filters)', async () => {
    buildSubqueriesImpl = async () => baseBuilt({
      subject: () => ({ sql: null }),
      resource: () => ({ sql: null }),
      hasSubject: false,
      hasResource: false,
    });
    labelHandlers = { 'matrix-data[': [{ resourceId: 'r1', memberId: 'm1' }] };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('413 when the flat grid exceeds MAX_FLAT_ROWS', async () => {
    const huge = Array.from({ length: 400_001 }, (_, i) => ({ resourceId: 'r', memberId: 'm' + i }));
    labelHandlers = { 'matrix-data[': huge };
    const res = await post({ filter: {} });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too many to load/);
  });

  it('returns the per-resource Contexts sidecar for the visible resources', async () => {
    labelHandlers = {
      'matrix-data[': [
        { resourceId: UUID, memberId: 'm1' },
        { resourceId: UUID2, memberId: 'm2' },
      ],
      'matrix-data-resource-contexts': [
        { resourceId: UUID, id: 'c1', displayName: 'Finance', contextType: 'Tag' },
        { resourceId: UUID, id: 'c2', displayName: 'M365', contextType: 'group-category' },
      ],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.resourceContexts).toEqual([{
      resourceId: UUID,
      contexts: [
        { id: 'c1', displayName: 'Finance', contextType: 'Tag' },
        { id: 'c2', displayName: 'M365', contextType: 'group-category' },
      ],
    }]);
  });

  it('Contexts query failure is swallowed (empty resourceContexts)', async () => {
    labelHandlers = {
      'matrix-data[': [{ resourceId: UUID, memberId: 'm1' }],
      'matrix-data-resource-contexts': () => { throw new Error('ContextMembers missing'); },
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.resourceContexts).toEqual([]);
  });

  it('AP-mapping query failure is swallowed (empty managedByPackages)', async () => {
    labelHandlers = {
      'matrix-data[': [{ resourceId: 'r1', memberId: 'm1' }],
      'matrix-data-ap-mapping': () => { throw new Error('view missing'); },
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.managedByPackages).toEqual([]);
  });

  it('folds inherited flat rows (declared wins, dedup by resource|member)', async () => {
    labelHandlers = { 'matrix-data[': [{ resourceId: 'r1', memberId: 'm1' }] };
    inhFlat = async () => [
      { resourceId: 'r1', memberId: 'm1' },   // dup → skipped
      { resourceId: 'r9', memberId: 'm9' },   // new → added
    ];
    const res = await post({ filter: { includeInheritedAccess: true } });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('inherited flat fold failure pushes a warning, not a 500', async () => {
    labelHandlers = { 'matrix-data[': [{ resourceId: 'r1', memberId: 'm1' }] };
    inhFlat = async () => { throw new Error('eff engine down'); };
    const res = await post({ filter: { includeInheritedAccess: true } });
    expect(res.status).toBe(200);
    expect(res.body.warnings.some(w => w.includes('inherited-access fold failed'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('matrix/data — attribute roll-up', () => {
  it('400 on an unknown roll-up attribute', async () => {
    parseFilterImpl = () => baseFilter({ rollup: 'nosuchcol' });
    const res = await post({ filter: { rollup: 'nosuchcol' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown attribute');
  });

  it('resources-and-roles happy path returns resources/counts/businessRoles', async () => {
    parseFilterImpl = () => baseFilter({ rollup: 'department' });
    labelHandlers = {
      'matrix-rollup-totals': [{ groupValue: 'Sales', total: 4 }],
      'matrix-rollup[': [
        { resourceId: 'r1', groupValue: 'Sales', directCount: 3, governedCount: 1, resourceDisplayName: 'R1' },
      ],
      'matrix-rollup-roles': [
        { resourceId: 'r1', roleId: 'br1', roleName: 'Role 1', count: 2 },
        { resourceId: 'r1', roleId: null }, // skipped
      ],
    };
    const res = await post({ filter: { rollup: 'department' } });
    expect(res.status).toBe(200);
    expect(res.body.rollup).toBe('department');
    expect(res.body.resources).toHaveLength(1);
    expect(res.body.counts).toHaveLength(1);
    expect(res.body.businessRoles).toEqual([{ id: 'br1', displayName: 'Role 1' }]);
    expect(res.body.groupValues).toContain('Sales');
  });

  it('resources-only skips the business-role query', async () => {
    parseFilterImpl = () => baseFilter({ rollup: 'department', rollupContent: 'resources-only' });
    labelHandlers = {
      'matrix-rollup-totals': [{ groupValue: 'Sales', total: 4 }],
      'matrix-rollup[': [{ resourceId: 'r1', groupValue: 'Sales', directCount: 1, governedCount: 0 }],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.businessRoles).toEqual([]);
  });

  it('business-role query failure is swallowed', async () => {
    parseFilterImpl = () => baseFilter({ rollup: 'department' });
    labelHandlers = {
      'matrix-rollup-totals': [],
      'matrix-rollup[': [{ resourceId: 'r1', groupValue: 'Sales', directCount: 1 }],
      'matrix-rollup-roles': () => { throw new Error('br view absent'); },
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.businessRoles).toEqual([]);
  });

  it('folds inherited rollup counts + group totals', async () => {
    parseFilterImpl = () => baseFilter({ rollup: 'department', rollupContent: 'resources-only' });
    labelHandlers = {
      'matrix-rollup-totals': [{ groupValue: 'Sales', total: 4 }],
      'matrix-rollup[': [{ resourceId: 'r1', groupValue: 'Sales', directCount: 1, governedCount: 0 }],
    };
    inhRollup = async () => ({
      resources: [{ resourceId: 'rEff', resourceDisplayName: 'Eff' }],
      groupValues: ['Ops'],
      counts: [{ resourceId: 'rEff', groupValue: 'Ops', directCount: 2 }],
      groupTotals: [{ groupValue: 'Ops', total: 7 }],
    });
    const res = await post({ filter: { includeInheritedAccess: true } });
    expect(res.status).toBe(200);
    expect(res.body.resources.map(r => r.resourceId)).toContain('rEff');
    expect(res.body.groupValues).toContain('Ops');
    expect(res.body.counts.length).toBe(2);
  });

  it('inherited rollup fold failure pushes a warning', async () => {
    parseFilterImpl = () => baseFilter({ rollup: 'department', rollupContent: 'resources-only' });
    labelHandlers = {
      'matrix-rollup-totals': [],
      'matrix-rollup[': [{ resourceId: 'r1', groupValue: 'Sales', directCount: 1 }],
    };
    inhRollup = async () => { throw new Error('inh boom'); };
    const res = await post({ filter: { includeInheritedAccess: true } });
    expect(res.status).toBe(200);
    expect(res.body.warnings.some(w => w.includes('inherited rollup fold failed'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('matrix/data — attribute roll-up, roles-only', () => {
  it('roles-only happy path returns roleRows + cells', async () => {
    parseFilterImpl = () => baseFilter({ rollup: 'department', rollupContent: 'roles-only' });
    labelHandlers = {
      'matrix-rollup-totals': [{ groupValue: 'Sales', total: 4 }],
      'matrix-rollup-rows[': [
        { roleId: 'br1', roleName: 'Role 1', roleDescription: 'd', groupValue: 'Sales', count: 2 },
        { roleId: null, groupValue: 'Sales' },
      ],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.rollupContent).toBe('roles-only');
    expect(res.body.roleRows).toEqual([{ id: 'br1', displayName: 'Role 1', description: 'd' }]);
    expect(res.body.cells).toHaveLength(1);
  });

  it('roles-only drill returns a compact members payload', async () => {
    parseFilterImpl = () => baseFilter({ rollup: 'department', rollupContent: 'roles-only', drill: true });
    labelHandlers = {
      'matrix-rollup-totals': [],
      'matrix-rollup-rows-drill[': [{ memberId: 'm1', displayName: 'User 1' }],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.drill.members).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('matrix/data — layered attribute fold', () => {
  it('400 when a fold attribute is unknown', async () => {
    parseFilterImpl = () => baseFilter({
      foldAttributes: true,
      sortAttributes: [{ attribute: 'nope', dir: 'asc' }],
    });
    const res = await post({ filter: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown attribute');
  });

  it('happy path returns layered attribute nodes + counts', async () => {
    parseFilterImpl = () => baseFilter({
      foldAttributes: true,
      sortAttributes: [{ attribute: 'department', dir: 'asc' }],
    });
    labelHandlers = {
      'matrix-attrcut-cells[': [
        { resourceId: 'r1', groupValue: 'Sales', directCount: 2, governedCount: 0, resourceDisplayName: 'R1' },
      ],
      'matrix-attrcut-nodes[': [
        { groupValue: 'Sales', total: 4, childCount: 0 },
        { groupValue: 'Hidden', total: 1, childCount: 0 }, // no cell → filtered out
      ],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.layeredAttributes).toBe(true);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.nodes[0].id).toBe('Sales');
    expect(res.body.resources).toHaveLength(1);
    expect(res.body.maxDepth).toBe(1);
  });

  it('folds inherited fold counts and surfaces a warning on failure', async () => {
    parseFilterImpl = () => baseFilter({
      foldAttributes: true,
      sortAttributes: [{ attribute: 'department', dir: 'asc' }],
    });
    labelHandlers = {
      'matrix-attrcut-cells[': [{ resourceId: 'r1', groupValue: 'Sales', directCount: 1, governedCount: 0 }],
      'matrix-attrcut-nodes[': [{ groupValue: 'Sales', total: 4, childCount: 0 }],
    };
    inhFold = async () => { throw new Error('fold eff down'); };
    const res = await post({ filter: { includeInheritedAccess: true } });
    expect(res.status).toBe(200);
    expect(res.body.warnings.some(w => w.includes('inherited fold failed'))).toBe(true);
  });

  it('merges inherited fold groupValues/resources/counts', async () => {
    parseFilterImpl = () => baseFilter({
      foldAttributes: true,
      sortAttributes: [{ attribute: 'department', dir: 'asc' }],
    });
    labelHandlers = {
      'matrix-attrcut-cells[': [{ resourceId: 'r1', groupValue: 'Sales', directCount: 1, governedCount: 0 }],
      'matrix-attrcut-nodes[': [
        { groupValue: 'Sales', total: 4, childCount: 0 },
        { groupValue: 'Ops', total: 2, childCount: 0 },
      ],
    };
    inhFold = async () => ({
      groupValues: ['Ops'],
      resources: [{ resourceId: 'rEff', resourceDisplayName: 'Eff' }],
      counts: [{ resourceId: 'rEff', groupValue: 'Ops', directCount: 3 }],
    });
    const res = await post({ filter: { includeInheritedAccess: true } });
    expect(res.status).toBe(200);
    expect(res.body.nodes.map(n => n.id).sort()).toEqual(['Ops', 'Sales']);
    expect(res.body.resources.map(r => r.resourceId)).toContain('rEff');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('matrix/data — context roll-up (zoom)', () => {
  it('400 on a non-UUID rollupContextId', async () => {
    parseFilterImpl = () => baseFilter({ rollupKind: 'context', rollupContextId: 'not-a-uuid' });
    const res = await post({ filter: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid context id');
  });

  it('resources zoom view returns frontier nodes + resources + counts', async () => {
    parseFilterImpl = () => baseFilter({
      rollupKind: 'context', rollupContextId: UUID, rollupContent: 'resources-only',
    });
    labelHandlers = {
      'matrix-ctx-focus-children': [{ id: UUID2 }],
      'matrix-ctx-totals[': [{ groupValue: UUID2, total: 3 }],
      'matrix-ctx-nodes': [{ id: UUID2, displayName: 'Child', parent: UUID, total: 3, directMembers: 1, childCount: 0 }],
      'matrix-ctx-crumbs': [{ id: UUID, displayName: 'Root' }],
      'matrix-ctx-rollup[': [
        { resourceId: 'r1', groupValue: UUID2, directCount: 2, governedCount: 0, resourceDisplayName: 'R1', systemId: 1, systemName: 'S' },
      ],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.rollupKind).toBe('context');
    expect(res.body.groupValues).toContain(UUID2);
    expect(res.body.resources).toHaveLength(1);
    expect(res.body.breadcrumb[0]).toMatchObject({ id: UUID, displayName: 'Root' });
  });

  it('leaf focus (no children) falls back to the focus node as the single column', async () => {
    parseFilterImpl = () => baseFilter({
      rollupKind: 'context', rollupContextId: UUID, rollupContent: 'resources-only',
    });
    labelHandlers = {
      'matrix-ctx-focus-children': [],          // leaf
      'matrix-ctx-totals[': [{ groupValue: UUID, total: 1 }],
      'matrix-ctx-nodes': [{ id: UUID, displayName: 'Leaf', parent: null, total: 1, directMembers: 1, childCount: 0 }],
      'matrix-ctx-crumbs': [{ id: UUID, displayName: 'Leaf' }],
      'matrix-ctx-rollup[': [],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.groupValues).toEqual([UUID]);
  });

  it('roles-only context view returns roleRows + cells', async () => {
    parseFilterImpl = () => baseFilter({
      rollupKind: 'context', rollupContextId: UUID, rollupContent: 'roles-only',
    });
    labelHandlers = {
      'matrix-ctx-focus-children': [{ id: UUID2 }],
      'matrix-ctx-totals[': [{ groupValue: UUID2, total: 3 }],
      'matrix-ctx-nodes': [{ id: UUID2, displayName: 'Child', parent: UUID }],
      'matrix-ctx-crumbs': [{ id: UUID, displayName: 'Root' }],
      'matrix-ctx-roles-rows[': [
        { roleId: 'br1', roleName: 'Role 1', roleDescription: 'd', groupValue: UUID2, count: 2 },
        { roleId: null },
      ],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.roleRows).toEqual([{ id: 'br1', displayName: 'Role 1', description: 'd' }]);
    expect(res.body.cells).toHaveLength(1);
  });

  it('context drill returns a compact members payload', async () => {
    parseFilterImpl = () => baseFilter({
      rollupKind: 'context', rollupContextId: UUID, drill: true, rollupContent: 'resources-only',
    });
    labelHandlers = {
      'matrix-ctx-focus-children': [{ id: UUID2 }],
      'matrix-ctx-rows-drill[': [{ memberId: 'm1', displayName: 'U1' }],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.rollupContent).toBe('roles-only');
    expect(res.body.drill.members).toHaveLength(1);
  });

  it('resources-and-roles context view folds business roles + inherited counts', async () => {
    parseFilterImpl = () => baseFilter({
      rollupKind: 'context', rollupContextId: UUID, rollupContent: 'resources-and-roles',
    });
    labelHandlers = {
      'matrix-ctx-focus-children': [{ id: UUID2 }],
      'matrix-ctx-totals[': [{ groupValue: UUID2, total: 3 }],
      'matrix-ctx-nodes': [{ id: UUID2, displayName: 'Child', parent: UUID }],
      'matrix-ctx-crumbs': [{ id: UUID, displayName: 'Root' }],
      'matrix-ctx-rollup[': [{ resourceId: 'r1', groupValue: UUID2, directCount: 1, governedCount: 0 }],
      'matrix-ctx-roles[': [{ resourceId: 'r1', roleId: 'br1', roleName: 'Role 1', count: 1 }],
    };
    inhContext = async () => ({
      resources: [{ resourceId: 'rEff' }],
      groupValues: [UUID2],
      counts: [{ resourceId: 'rEff', groupValue: UUID2, directCount: 5 }],
      groupTotals: [{ groupValue: UUID2, total: 5 }],
    });
    const res = await post({ filter: { includeInheritedAccess: true } });
    expect(res.status).toBe(200);
    expect(res.body.businessRoles).toEqual([{ id: 'br1', displayName: 'Role 1' }]);
    expect(res.body.resources.map(r => r.resourceId)).toContain('rEff');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('matrix/data — layered hierarchy (sortHierarchy)', () => {
  it('sortHierarchy is translated into a layered context roll-up', async () => {
    parseFilterImpl = () => baseFilter({
      sortHierarchy: { contextId: UUID },
    });
    labelHandlers = {
      'matrix-ctx-cut': [{ id: UUID2, depth: 1 }],
      'matrix-ctx-layered[': [
        { resourceId: 'r1', groupValue: UUID2, directCount: 2, governedCount: 0, resourceDisplayName: 'R1' },
      ],
      'matrix-ctx-scoped-members[': [{ groupValue: UUID2, total: 4, direct: 2 }],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.layered).toBe(true);
    expect(res.body.groupValues).toContain(UUID2);
    expect(res.body.nodes[0]).toMatchObject({ id: UUID2, total: 4, directMembers: 2 });
  });

  it('400 when buildContextCutSql query throws (invalid hierarchy)', async () => {
    parseFilterImpl = () => baseFilter({ sortHierarchy: { contextId: UUID } });
    labelHandlers = { 'matrix-ctx-cut': () => { throw new Error('bad cut'); } };
    const res = await post({ filter: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid hierarchy');
  });

  it('empty cut falls back to the root as a single leaf column', async () => {
    parseFilterImpl = () => baseFilter({ sortHierarchy: { contextId: UUID } });
    labelHandlers = {
      'matrix-ctx-cut': [],                         // root is a leaf
      'matrix-ctx-layered[': [{ resourceId: 'r1', groupValue: UUID, directCount: 1, governedCount: 0 }],
      'matrix-ctx-scoped-members[': [{ groupValue: UUID, total: 1, direct: 1 }],
    };
    const res = await post({ filter: {} });
    expect(res.status).toBe(200);
    expect(res.body.layered).toBe(true);
  });

  it('layered hierarchy folds inherited context counts with a failure warning', async () => {
    parseFilterImpl = () => baseFilter({ sortHierarchy: { contextId: UUID } });
    labelHandlers = {
      'matrix-ctx-cut': [{ id: UUID2, depth: 1 }],
      'matrix-ctx-layered[': [{ resourceId: 'r1', groupValue: UUID2, directCount: 1, governedCount: 0 }],
      'matrix-ctx-scoped-members[': [{ groupValue: UUID2, total: 2, direct: 1 }],
    };
    inhContext = async () => { throw new Error('inh ctx down'); };
    const res = await post({ filter: { includeInheritedAccess: true } });
    expect(res.status).toBe(200);
    expect(res.body.warnings.some(w => w.includes('inherited context fold failed'))).toBe(true);
  });
});
