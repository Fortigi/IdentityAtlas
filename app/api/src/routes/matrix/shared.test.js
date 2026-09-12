// Unit tests for the helpers in matrix/shared.js (Q1 split). db / sqlTimer /
// columnCache / filterSql are mocked; the pure functions don't touch them, and
// the DB-backed ones (buildSubqueries / runCount / scopeCounts) drive the mocks.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbQuery, timedQ, buildEntity } = vi.hoisted(() => ({
  dbQuery: vi.fn(async () => ({ rows: [] })),
  timedQ: vi.fn(async () => ({ rows: [] })),
  buildEntity: vi.fn(() => ({ sql: null, warnings: [] })),
}));

vi.mock('../../db/connection.js', () => ({ query: (...a) => dbQuery(...a), queryOne: vi.fn(), getPool: vi.fn() }));
vi.mock('../../perf/sqlTimer.js', () => ({ timedQuery: (...a) => timedQ(...a) }));
vi.mock('../../db/columnCache.js', () => ({ getPrincipalColumns: async () => [], getResourceColumns: async () => [] }));
vi.mock('../../matrix/filterSql.js', () => ({ buildEntitySubquery: (...a) => buildEntity(...a), collectContextIds: () => [] }));

const {
  parseFilter, normaliseBlock, subjectScopeClauses, normaliseSortAttributes,
  buildSubqueries, runCount, scopeCounts, runBound, collectResources,
} = await import('./shared.js');
const { createParams } = await import('../../db/sqlParams.js');

beforeEach(() => {
  dbQuery.mockReset().mockResolvedValue({ rows: [] });
  timedQ.mockReset().mockResolvedValue({ rows: [] });
  buildEntity.mockReset().mockReturnValue({ sql: null, warnings: [] });
});

describe('parseFilter', () => {
  it('returns null when no filter object is present', () => {
    expect(parseFilter(undefined)).toBeNull();
    expect(parseFilter({})).toBeNull();
    expect(parseFilter({ filter: 'nope' })).toBeNull();
  });

  it('defaults rowType to principal and normalises blocks', () => {
    const f = parseFilter({ filter: {} });
    expect(f.rowType).toBe('principal');
    expect(f.subject).toEqual({ include: [], exclude: [] });
    expect(f.resource).toEqual({ include: [], exclude: [] });
    expect(f.rollup).toBeNull();
    expect(f.rollupContent).toBe('resources-and-roles');
    expect(f.rollupMetric).toBe('count');
  });

  it('accepts identity rowType and validated enum-ish fields', () => {
    const f = parseFilter({ filter: { rowType: 'identity', rollupContent: 'roles-only', rollupMetric: 'percent', rollup: 'department' } });
    expect(f.rowType).toBe('identity');
    expect(f.rollupContent).toBe('roles-only');
    expect(f.rollupMetric).toBe('percent');
    expect(f.rollup).toBe('department');
  });

  it('rejects an unknown rowType back to principal', () => {
    expect(parseFilter({ filter: { rowType: 'banana' } }).rowType).toBe('principal');
  });

  it('defaults includeBusinessRoles off and accepts only a real boolean true', () => {
    expect(parseFilter({ filter: {} }).includeBusinessRoles).toBe(false);
    expect(parseFilter({ filter: { includeBusinessRoles: true } }).includeBusinessRoles).toBe(true);
    // A saved matrix round-trips through JSONB; a stringy leftover must not
    // silently switch a shared matrix to showing business-role rows.
    expect(parseFilter({ filter: { includeBusinessRoles: 'true' } }).includeBusinessRoles).toBe(false);
    expect(parseFilter({ filter: { includeBusinessRoles: 1 } }).includeBusinessRoles).toBe(false);
  });
});

describe('normaliseBlock', () => {
  it('returns empty arrays for missing/invalid input', () => {
    expect(normaliseBlock(undefined)).toEqual({ include: [], exclude: [] });
    expect(normaliseBlock({ include: 'x' })).toEqual({ include: [], exclude: [] });
  });
  it('keeps array include/exclude', () => {
    expect(normaliseBlock({ include: [1], exclude: [2] })).toEqual({ include: [1], exclude: [2] });
  });
});

describe('subjectScopeClauses', () => {
  it('excludes group-shaped accounts for principals and adds the id clause', () => {
    const c = subjectScopeClauses('principal', '(SELECT id FROM x)');
    expect(c.subjectTable).toBe('Principals');
    expect(c.where).toContain(`"principalType" != '#microsoft.graph.group'`);
    expect(c.where).toContain('id IN (SELECT id FROM x)');
    expect(c.baseWhere).toContain('principalType');
  });

  it('does not exclude group accounts for identities and has no base filter', () => {
    const c = subjectScopeClauses('identity', null);
    expect(c.subjectTable).toBe('Identities');
    expect(c.where).toBe('');
    expect(c.baseWhere).toBe('');
  });
});

describe('normaliseSortAttributes (re-exported from shared)', () => {
  it('defaults to [department asc]', () => {
    expect(normaliseSortAttributes(undefined)).toEqual([{ attribute: 'department', dir: 'asc' }]);
  });
});

describe('buildSubqueries', () => {
  it('returns render closures + false presence flags for an empty filter', async () => {
    const built = await buildSubqueries(parseFilter({ filter: {} }));
    expect(typeof built.subject).toBe('function');
    expect(typeof built.resource).toBe('function');
    expect(built.hasSubject).toBe(false);
    expect(built.hasResource).toBe(false);
    expect(built.warnings).toEqual([]);
    // Each closure renders through its own binder; empty filter → null fragment.
    const { bind } = createParams();
    expect(built.subject(bind).sql).toBeNull();
    expect(built.resource(bind).sql).toBeNull();
  });

  it('flags hasSubject/hasResource and concatenates both sides’ warnings when fragments render', async () => {
    buildEntity.mockReturnValue({ sql: '(SELECT id FROM "X")', warnings: ['w'] });
    const built = await buildSubqueries(parseFilter({ filter: { rowType: 'identity' } }));
    expect(built.hasSubject).toBe(true);
    expect(built.hasResource).toBe(true);
    // subject + resource each contribute their warnings.
    expect(built.warnings).toEqual(['w', 'w']);
  });

  // ── Default row visibility (#937) ──────────────────────────────────
  // buildSubqueries is the single choke point: every matrix mode embeds the
  // resource fragment it returns, so what is asserted here is what the flat
  // grid, the roll-ups, the context zoom, the fold, the counts and the
  // nested-group expansion all get.
  const resourceCalls = () => buildEntity.mock.calls.map(([a]) => a).filter(a => a.entity === 'Resource');
  const VISIBLE = `("resourceType" IS NULL OR "resourceType" NOT IN ('BusinessRole'))`;

  it('pushes the row-visibility clause into the resource fragment by default', async () => {
    const built = await buildSubqueries(parseFilter({ filter: {} }));
    const { bind } = createParams();
    built.resource(bind);
    // The rendering closure — not just the throwaway probe — must carry it.
    expect(resourceCalls().at(-1).extraClauses).toEqual([VISIBLE]);
    expect(built.hidesDefaultResourceTypes).toBe(true);
    expect(built.resourceTotalWhere).toBe(` WHERE ${VISIBLE}`);
  });

  it('drops the clause when the matrix opts business roles back in', async () => {
    const built = await buildSubqueries(parseFilter({ filter: { includeBusinessRoles: true } }));
    const { bind } = createParams();
    built.resource(bind);
    expect(resourceCalls().at(-1).extraClauses).toEqual([]);
    expect(built.hidesDefaultResourceTypes).toBe(false);
    // …and the unscoped total stops excluding them too, so "X of Y resources"
    // counts exactly the rows that can render.
    expect(built.resourceTotalWhere).toBe('');
  });

  it('drops the clause when the resource scope explicitly targets business roles', async () => {
    const built = await buildSubqueries(parseFilter({ filter: { resource: {
      include: [{ kind: 'attribute', field: 'resourceType', values: ['BusinessRole'] }],
    } } }));
    expect(built.hidesDefaultResourceTypes).toBe(false);
    const { bind } = createParams();
    built.resource(bind);
    expect(resourceCalls().at(-1).extraClauses).toEqual([]);
  });

  it('keeps hasResource meaning "the analyst scoped resources", not "a clause was added"', async () => {
    // inheritedAccess only folds inherited rows for a bounded resource scope;
    // if the policy clause counted as a scope, an unscoped matrix would start
    // running the effective-access engine over every resource.
    const built = await buildSubqueries(parseFilter({ filter: {} }));
    expect(built.hasResource).toBe(false);
    // The probe call that decides the flag renders without the clause…
    const probe = resourceCalls().at(-1);
    expect(probe.extraClauses).toBeUndefined();
    // …and the fragment the queries actually embed is still non-null.
    buildEntity.mockReturnValue({ sql: '(SELECT id FROM "Resources" WHERE …)', warnings: [] });
    expect(built.resource(createParams().bind).sql).not.toBeNull();
  });

  it('routes identity rowType to the Identity subject entity', async () => {
    await buildSubqueries(parseFilter({ filter: { rowType: 'identity' } }));
    const entities = buildEntity.mock.calls.map(([arg]) => arg.entity);
    expect(entities).toContain('Identity');
    expect(entities).toContain('Resource');
    expect(entities).not.toContain('Principal');
  });
});

describe('runCount', () => {
  it('returns the integer c from the first row', async () => {
    timedQ.mockResolvedValueOnce({ rows: [{ c: 7 }] });
    expect(await runCount({}, 'lbl', {}, 'SELECT 1 AS c', [])).toBe(7);
  });

  it('defaults to 0 when there is no row', async () => {
    timedQ.mockResolvedValueOnce({ rows: [] });
    expect(await runCount({}, 'lbl', {}, 'SELECT 1 AS c', [])).toBe(0);
  });
});

describe('scopeCounts', () => {
  it('renders each COUNT with its own params and returns the four counts', async () => {
    // Subject fragment present, resource fragment null — exercises both branches
    // of subjectScopeClauses/scopeCounts and the resource IN-clause guard.
    buildEntity.mockImplementation(({ entity }) =>
      entity === 'Resource' ? { sql: null, warnings: [] } : { sql: '(SELECT id FROM "Principals")', warnings: [] });
    timedQ.mockResolvedValue({ rows: [{ c: 4 }] });

    const built = await buildSubqueries(parseFilter({ filter: {} }));
    const out = await scopeCounts({}, {}, 'principal', built);
    expect(out).toEqual({ subjectCount: 4, subjectTotal: 4, resourceCount: 4, resourceTotal: 4 });
    // The resource-count query has no IN clause when the resource fragment is null.
    const resourceCountSql = timedQ.mock.calls.find(c => c[1] === 'matrix-data-resource-count')[3];
    expect(resourceCountSql).not.toContain('WHERE id IN');
  });

  const totalSql = () => timedQ.mock.calls.find(c => c[1] === 'matrix-data-resource-total')[3];

  it('applies the row-visibility predicate to the unscoped resource total', async () => {
    timedQ.mockResolvedValue({ rows: [{ c: 4 }] });
    await scopeCounts({}, {}, 'principal', await buildSubqueries(parseFilter({ filter: {} })));
    // "X of Y resources" must never count rows the matrix cannot render.
    expect(totalSql()).toBe(
      `SELECT COUNT(*)::int AS c FROM "Resources" WHERE ("resourceType" IS NULL OR "resourceType" NOT IN ('BusinessRole'))`);
  });

  it('counts every resource in the total once business roles are shown', async () => {
    timedQ.mockResolvedValue({ rows: [{ c: 4 }] });
    await scopeCounts({}, {}, 'principal',
      await buildSubqueries(parseFilter({ filter: { includeBusinessRoles: true } })));
    expect(totalSql()).toBe('SELECT COUNT(*)::int AS c FROM "Resources"');
  });
});

describe('runBound', () => {
  it('binds subject then resource then render params, runs the rendered SQL, returns the result', async () => {
    timedQ.mockResolvedValueOnce({ rows: [{ x: 1 }] });
    const built = {
      subject: (bind) => ({ sql: `SUBJ(${bind('s')})` }),
      resource: (bind) => ({ sql: `RES(${bind('r')})` }),
    };
    const out = await runBound({}, 'lbl', {}, built,
      ({ subjectSql, resourceSql, bind }) => `SELECT ${subjectSql} ${resourceSql} ${bind('extra')}`);
    expect(out).toEqual({ rows: [{ x: 1 }] });
    const [, label, , sql, params] = timedQ.mock.calls[0];
    expect(label).toBe('lbl');
    expect(sql).toBe('SELECT SUBJ($1) RES($2) $3');   // subject $1, resource $2, render $3
    expect(params).toEqual(['s', 'r', 'extra']);
  });

  it('skips the resource fragment (binds no resource params) when { resource:false }', async () => {
    timedQ.mockResolvedValueOnce({ rows: [] });
    const resource = vi.fn();
    const built = { subject: (bind) => ({ sql: `SUBJ(${bind('s')})` }), resource };
    await runBound({}, 'lbl', {}, built,
      ({ subjectSql, resourceSql }) => `Q ${subjectSql} [${resourceSql}]`, { resource: false });
    expect(resource).not.toHaveBeenCalled();
    const [, , , sql, params] = timedQ.mock.calls[0];
    expect(sql).toBe('Q SUBJ($1) []');   // resourceSql defaults to '' — no resource params
    expect(params).toEqual(['s']);
  });
});

describe('collectResources', () => {
  it('maps rows through resourceMeta, keeps the first per resourceId, skips falsy ids', () => {
    const rows = [
      { resourceId: 'a', resourceDisplayName: 'A', resourceType: 'Group', resourceDescription: 'd', systemId: 1, systemName: 'S' },
      { resourceId: 'a', resourceDisplayName: 'A-dup' },   // duplicate id ignored
      { resourceId: null, resourceDisplayName: 'skip' },   // falsy id skipped
    ];
    const map = collectResources(new Map(), rows);
    expect([...map.keys()]).toEqual(['a']);
    expect(map.get('a')).toEqual({
      resourceId: 'a', resourceDisplayName: 'A', resourceType: 'Group',
      resourceDescription: 'd', systemId: 1, systemName: 'S',
    });
  });

  it('accepts an identity mapper to merge shaped objects and tolerates null rows', () => {
    const map = new Map([['a', { resourceId: 'a' }]]);
    const obj = { resourceId: 'b', foo: 1 };
    collectResources(map, [obj, { resourceId: 'a', foo: 2 }], r => r);  // 'a' present → kept
    collectResources(map, null, r => r);                                 // null rows → no-op
    expect(map.get('b')).toBe(obj);                     // identity mapper stores as-is
    expect(map.get('a')).toEqual({ resourceId: 'a' });  // existing 'a' not overwritten
  });
});
