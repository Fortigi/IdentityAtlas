import { describe, it, expect, beforeEach } from 'vitest';
import {
  RELATIONSHIP_FILTERS,
  applyRelationshipFilters,
  advertiseRelationshipColumns,
  _resetTableExistsCache,
} from './relationshipFilters.js';

// A stub pool. `tables` is the set of existing (unquoted) table names;
// `probe` is what a spec.probe query returns for its `e` column; `throwOn`
// forces query() to reject when the SQL matches the substring.
function makePool({ tables = new Set(), probe = true, throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      if (throwOn && sql.includes(throwOn)) throw new Error('boom');
      if (sql.includes('to_regclass')) {
        const quoted = args[0]; // e.g. "PrincipalRelationships"
        const name = quoted.replace(/"/g, '');
        return { rows: [{ t: tables.has(name) ? 1234 : null }] };
      }
      // a spec.probe (SELECT EXISTS(...) AS e)
      return { rows: [{ e: probe }] };
    },
  };
}

const PRINCIPAL_TABLES = new Set(['PrincipalRelationships']);
const RESOURCE_TABLES = new Set(['ResourceRelationships', 'ResourceAssignments']);

beforeEach(() => _resetTableExistsCache());

describe('RELATIONSHIP_FILTERS spec', () => {
  it('exposes principal.hasOwner and resource.hasOwner/hasMembers with sql+probe+requires', () => {
    expect(Object.keys(RELATIONSHIP_FILTERS.principal)).toEqual(['hasOwner']);
    expect(Object.keys(RELATIONSHIP_FILTERS.resource).sort()).toEqual(['hasMembers', 'hasOwner']);
    for (const domain of Object.values(RELATIONSHIP_FILTERS)) {
      for (const spec of Object.values(domain)) {
        expect(typeof spec.sql('x', 'EXISTS')).toBe('string');
        expect(spec.probe).toMatch(/EXISTS/);
        expect(Array.isArray(spec.requires)).toBe(true);
      }
    }
  });

  it('interpolates the alias and operator into the predicate', () => {
    const sql = RELATIONSHIP_FILTERS.principal.hasOwner.sql('u', 'NOT EXISTS');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('pr."principalId" = u.id');
    expect(sql).toContain("'Owner'");
  });
});

describe('applyRelationshipFilters', () => {
  it('returns "" for an unknown domain', async () => {
    expect(await applyRelationshipFilters(makePool(), 'nope', { hasOwner: 'Yes' }, 'u')).toBe('');
  });

  it('returns "" when filters is null', async () => {
    expect(await applyRelationshipFilters(makePool(), 'principal', null, 'u')).toBe('');
  });

  it('maps Yes -> EXISTS and deletes the consumed key', async () => {
    const filters = { hasOwner: 'Yes', department: 'IT' };
    const frag = await applyRelationshipFilters(makePool({ tables: PRINCIPAL_TABLES }), 'principal', filters, 'u');
    expect(frag).toBe(` AND ${RELATIONSHIP_FILTERS.principal.hasOwner.sql('u', 'EXISTS')}`);
    expect(filters).toEqual({ department: 'IT' }); // hasOwner consumed, other key untouched
  });

  it('maps No -> NOT EXISTS', async () => {
    const frag = await applyRelationshipFilters(makePool({ tables: PRINCIPAL_TABLES }), 'principal', { hasOwner: 'No' }, 'u');
    expect(frag).toContain('NOT EXISTS');
  });

  it('ignores an invalid value but still consumes the key', async () => {
    const filters = { hasOwner: 'Maybe' };
    const frag = await applyRelationshipFilters(makePool({ tables: PRINCIPAL_TABLES }), 'principal', filters, 'u');
    expect(frag).toBe('');
    expect(filters).toEqual({});
  });

  it('skips the filter (no 500) when a required table is absent', async () => {
    const frag = await applyRelationshipFilters(makePool({ tables: new Set() }), 'principal', { hasOwner: 'No' }, 'u');
    expect(frag).toBe('');
  });

  it('skips the filter when the catalog query throws', async () => {
    const frag = await applyRelationshipFilters(makePool({ throwOn: 'to_regclass' }), 'principal', { hasOwner: 'Yes' }, 'u');
    expect(frag).toBe('');
  });

  it('combines both resource filters with AND', async () => {
    const filters = { hasOwner: 'No', hasMembers: 'No' };
    const frag = await applyRelationshipFilters(makePool({ tables: RESOURCE_TABLES }), 'resource', filters, 'r');
    expect(frag).toContain('rr."relationshipType" IN (\'HasOwnership\',\'HasAppOwnership\')');
    expect(frag).toContain('ra."resourceType" IS DISTINCT FROM \'GroupOwnership\'');
    expect((frag.match(/ AND NOT EXISTS \(/g) || []).length).toBe(2);
    expect(filters).toEqual({});
  });
});

describe('advertiseRelationshipColumns', () => {
  it('returns {} for an unknown domain', async () => {
    expect(await advertiseRelationshipColumns(makePool(), 'nope')).toEqual({});
  });

  it('advertises a field with Yes/No when the data exists', async () => {
    const out = await advertiseRelationshipColumns(makePool({ tables: PRINCIPAL_TABLES, probe: true }), 'principal');
    expect(out).toEqual({ hasOwner: ['Yes', 'No'] });
  });

  it('omits a field when the probe finds no data', async () => {
    const out = await advertiseRelationshipColumns(makePool({ tables: PRINCIPAL_TABLES, probe: false }), 'principal');
    expect(out).toEqual({});
  });

  it('omits a field when the required table is absent', async () => {
    const out = await advertiseRelationshipColumns(makePool({ tables: new Set() }), 'principal');
    expect(out).toEqual({});
  });

  it('omits a field when the probe throws', async () => {
    const out = await advertiseRelationshipColumns(makePool({ tables: RESOURCE_TABLES, throwOn: 'SELECT EXISTS' }), 'resource');
    expect(out).toEqual({});
  });
});
