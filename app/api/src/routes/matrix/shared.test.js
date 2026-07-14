// Unit tests for the pure helpers extracted into matrix/shared.js (Q1 split).
// db / sqlTimer are mocked only to keep the import side-effect-free; the
// functions under test don't touch them.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ query: vi.fn(), queryOne: vi.fn(), getPool: vi.fn() }));
vi.mock('../../perf/sqlTimer.js', () => ({ timedQuery: async () => ({ rows: [] }) }));
vi.mock('../../db/columnCache.js', () => ({ getPrincipalColumns: async () => [], getResourceColumns: async () => [] }));
vi.mock('../../matrix/filterSql.js', () => ({ buildEntitySubquery: () => ({ sql: null, bindings: {}, warnings: [] }), collectContextIds: () => [] }));

const { parseFilter, normaliseBlock, subjectScopeClauses, normaliseSortAttributes } = await import('./shared.js');

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
