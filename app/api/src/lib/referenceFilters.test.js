import { describe, it, expect, vi } from 'vitest';
import {
  buildRelationshipWhere,
  extractRelFilters,
  storeForEntityType,
  discoverReferenceFields,
  MULTI_OPTIONS,
  SINGLE_OPTIONS,
} from './referenceFilters.js';

// Test helper: build the {field,value}[] shape extractRelFilters produces.
const R = (...pairs) => pairs.map(([field, value]) => ({ field, value }));

describe('extractRelFilters', () => {
  it('collects rel.* keys as {field,value} pairs, leaving the source intact', () => {
    const attr = { department: 'IT', 'rel.owners': 'None (0)', 'ext.userType': 'Member' };
    expect(extractRelFilters(attr)).toEqual([{ field: 'rel.owners', value: 'None (0)' }]);
    // Not mutated — buildFilterWhere ignores rel.* keys anyway.
    expect(attr).toEqual({ department: 'IT', 'rel.owners': 'None (0)', 'ext.userType': 'Member' });
  });

  it('returns [] when there are no rel keys', () => {
    expect(extractRelFilters({ department: 'IT' })).toEqual([]);
    expect(extractRelFilters(null)).toEqual([]);
  });

  it('does not use the user key as a property name (carries it as data)', () => {
    const rel = extractRelFilters({ 'rel.__proto__': 'None (0)' });
    expect(rel).toEqual([{ field: 'rel.__proto__', value: 'None (0)' }]);
    expect(({}).polluted).toBeUndefined();
  });
});

describe('buildRelationshipWhere — operator emission', () => {
  const cases = [
    ['None (0)', '= 0'],
    ['Any (1 or more)', '>= 1'],
    ['Exactly 1', '= 1'],
    ['2 or more', '>= 2'],
    ['3 or more', '>= 3'],
  ];
  for (const [value, expected] of cases) {
    it(`maps "${value}" to a count ${expected}`, () => {
      const sql = buildRelationshipWhere(R(['rel.owners', value]), 'principals', 'u');
      expect(sql).toContain('PrincipalRelationships');
      expect(sql.trim().endsWith(expected)).toBe(true);
    });
  }

  it('references the subject alias in the correlated subquery', () => {
    const sql = buildRelationshipWhere(R(['rel.members', 'Any (1 or more)']), 'resources', 'r');
    expect(sql).toContain('ResourceAssignments');
    expect(sql).toContain('r.id');
  });

  it('composes multiple rel filters', () => {
    const sql = buildRelationshipWhere(
      R(['rel.owners', 'None (0)'], ['rel.directReports', '2 or more']),
      'principals', 'u',
    );
    expect(sql).toContain('= 0');
    expect(sql).toContain('>= 2');
  });
});

describe('buildRelationshipWhere — fail closed', () => {
  it('unknown rel key → AND 1=0 (never widens results)', () => {
    expect(buildRelationshipWhere(R(['rel.bogus', 'None (0)']), 'principals', 'u')).toBe(' AND 1=0');
  });

  it('unrecognised value → AND 1=0', () => {
    expect(buildRelationshipWhere(R(['rel.owners', "'; DROP TABLE"]), 'principals', 'u')).toBe(' AND 1=0');
  });

  it('an inherited-property value (constructor) → AND 1=0, not a truthy match', () => {
    expect(buildRelationshipWhere(R(['rel.owners', 'constructor']), 'principals', 'u')).toBe(' AND 1=0');
  });

  it('count operator on a single-valued relation (manager) → AND 1=0', () => {
    expect(buildRelationshipWhere(R(['rel.manager', '2 or more']), 'principals', 'u')).toBe(' AND 1=0');
  });

  it('single-valued None/Any are allowed', () => {
    expect(buildRelationshipWhere(R(['rel.manager', 'None (0)']), 'principals', 'u')).toContain('= 0');
    expect(buildRelationshipWhere(R(['rel.manager', 'Any (1 or more)']), 'principals', 'u')).toContain('>= 1');
  });

  it('unknown table with rel filters → AND 1=0', () => {
    expect(buildRelationshipWhere(R(['rel.owners', 'None (0)']), 'widgets', 'w')).toBe(' AND 1=0');
  });

  it('unsafe alias with rel filters → AND 1=0', () => {
    expect(buildRelationshipWhere(R(['rel.owners', 'None (0)']), 'principals', 'u; --')).toBe(' AND 1=0');
  });

  it('empty rel filters → empty string (no clause)', () => {
    expect(buildRelationshipWhere([], 'principals', 'u')).toBe('');
    expect(buildRelationshipWhere(null, 'principals', 'u')).toBe('');
  });

  it('a field from the wrong table is rejected (rel.members on principals)', () => {
    expect(buildRelationshipWhere(R(['rel.members', 'Any (1 or more)']), 'principals', 'u')).toBe(' AND 1=0');
  });
});

describe('storeForEntityType', () => {
  it('maps user→principals, resource/group→resources, identity→null', () => {
    expect(storeForEntityType('user')).toBe('principals');
    expect(storeForEntityType('resource')).toBe('resources');
    expect(storeForEntityType('group')).toBe('resources');
    expect(storeForEntityType('identity')).toBe(null);
  });
});

// ─── The discovery probe ────────────────────────────────────────────
//
// "Does any row in this view have this relation?" used to be asked as
// EXISTS(… WHERE (correlated count) >= 1), and an aggregate stops the planner
// from flattening the subquery: it evaluated the count once per subject row.
// On 176 k principals with no index on managerId that was 8.1 s per filter-bar
// load, and unbounded when the relation was empty. These tests pin the shape
// that lets the planner use a semi-join instead.

describe('discoverReferenceFields — the probe the planner can flatten', () => {
  const conn = (row) => ({ query: vi.fn(async () => ({ rows: [row] })) });

  it('never asks for a count — a count is the fence that made this slow', async () => {
    const c = conn({});
    await discoverReferenceFields('principals', {}, c);
    const [sql] = c.query.mock.calls[0];
    expect(sql).not.toMatch(/count\(\*\)/i);
    expect(sql).not.toMatch(/>= 1/);
  });

  it('puts the subject table and the relation in ONE flat FROM per probe', async () => {
    const c = conn({});
    await discoverReferenceFields('principals', {}, c);
    const [sql] = c.query.mock.calls[0];
    // directReports: both Principals aliases in one FROM, joined by managerId.
    expect(sql).toContain('FROM "Principals" X, "Principals" m');
    expect(sql).toContain('m."managerId" = X.id');
    // owners: driven from the relationship table, not from Principals.
    expect(sql).toContain('FROM "Principals" X, "PrincipalRelationships" pr');
  });

  it('probes every principal relation in one round trip', async () => {
    const c = conn({});
    await discoverReferenceFields('principals', {}, c);
    expect(c.query).toHaveBeenCalledTimes(1);
    expect(c.query.mock.calls[0][0].match(/EXISTS\(/g)).toHaveLength(5);
  });

  it('single-valued relations probe the column directly, with no second table', async () => {
    const c = conn({});
    await discoverReferenceFields('principals', {}, c);
    const [sql] = c.query.mock.calls[0];
    expect(sql).toMatch(/FROM "Principals" X\s+WHERE X\."deletedAt" IS NULL AND X\."managerId" IS NOT NULL/);
  });

  it('binds the sub-tab scope and applies it to the SUBJECT row, not the related one', async () => {
    const c = conn({});
    await discoverReferenceFields('principals', { principalType: 'AIAgent' }, c);
    const [sql, params] = c.query.mock.calls[0];
    expect(params).toEqual(['AIAgent']);
    expect(sql).toContain('X."principalType" = $1');
    expect(sql).not.toContain("'AIAgent'");
  });

  it('offers only the relations the probe found, with their picklists', async () => {
    // c0 owners, c1 sponsors, c2 manager, c3 ownsAgents, c4 directReports
    const c = conn({ c0: false, c1: false, c2: true, c3: false, c4: true });
    const fields = await discoverReferenceFields('principals', {}, c);
    expect(fields).toEqual([
      { column: 'rel.manager', label: 'Manager', values: SINGLE_OPTIONS },
      { column: 'rel.directReports', label: 'Direct reports', values: MULTI_OPTIONS },
    ]);
  });

  it('drives the resource probes from the assignment side too', async () => {
    const c = conn({});
    await discoverReferenceFields('resources', {}, c);
    const [sql] = c.query.mock.calls[0];
    expect(sql).toContain('FROM "Resources" X, "ResourceAssignments" ra');
    expect(sql).toContain('FROM "Resources" X, "ResourceRelationships" rr');
    expect(sql).not.toMatch(/count\(\*\)/i);
  });

  it('returns [] for a table with no reference fields, without querying', async () => {
    const c = conn({});
    expect(await discoverReferenceFields('widgets', {}, c)).toEqual([]);
    expect(c.query).not.toHaveBeenCalled();
  });

  it('ignores a blank scope value rather than binding it', async () => {
    const c = conn({});
    await discoverReferenceFields('principals', { principalType: '  ' }, c);
    expect(c.query.mock.calls[0][1]).toEqual([]);
  });
});

// The count and the probe are generated from ONE relation declaration, so a
// change to a relation cannot update the filter and leave the discovery probe
// describing something else.
describe('the count and the probe stay in step', () => {
  const relations = [
    ['principals', 'owners',        'PrincipalRelationships'],
    ['principals', 'sponsors',      'PrincipalRelationships'],
    ['principals', 'ownsAgents',    'PrincipalRelationships'],
    ['principals', 'directReports', '"Principals" m'],
    ['resources',  'members',       'ResourceAssignments'],
    ['resources',  'owners',        'ResourceRelationships'],
  ];
  for (const [table, key, marker] of relations) {
    it(`${table}.${key} names ${marker} in both shapes`, async () => {
      const filterSql = buildRelationshipWhere(
        [{ field: `rel.${key}`, value: 'Any (1 or more)' }], table, 'u');
      const c = { query: vi.fn(async () => ({ rows: [{}] })) };
      await discoverReferenceFields(table, {}, c);
      expect(filterSql).toContain(marker);
      expect(c.query.mock.calls[0][0]).toContain(marker);
    });
  }

  // Each relation's predicate, pinned once. These are the copy-paste mistakes
  // the registry invites — the entries differ only in a literal or in which
  // end of the relationship table is the subject — and each of them is silent:
  // Sponsors would quietly list owners, "Owns agents" would answer the
  // question "who owns THIS agent", and a tombstoned report or assignment
  // would keep a row looking populated. Whether the rows come back right is
  // contract-tests/referenceFilters.contract.test.js's job; that the two
  // generated shapes say what we meant is this one's.
  const predicates = [
    ['principals', 'owners',        `pr."principalId" = u.id AND pr."relationshipType" = 'Owner'`],
    ['principals', 'sponsors',      `pr."principalId" = u.id AND pr."relationshipType" = 'Sponsor'`],
    ['principals', 'ownsAgents',    `pr."relatedPrincipalId" = u.id AND pr."relationshipType" = 'Owner'`],
    ['principals', 'directReports', `m."managerId" = u.id AND m."deletedAt" IS NULL`],
    ['resources',  'members',       `ra."resourceId" = u.id AND ra."deletedAt" IS NULL`],
    ['resources',  'owners',        `rr."parentResourceId" = u.id AND rr."relationshipType" = 'HasOwnership'`],
  ];
  for (const [table, key, predicate] of predicates) {
    it(`${table}.${key} correlates on exactly: ${predicate}`, () => {
      const sql = buildRelationshipWhere(
        [{ field: `rel.${key}`, value: 'Any (1 or more)' }], table, 'u');
      expect(sql).toContain(predicate);
    });
  }

  it('the counted rows exclude tombstoned ones on both sides of a two-hop relation', () => {
    const sql = buildRelationshipWhere(
      [{ field: 'rel.owners', value: 'Any (1 or more)' }], 'resources', 'u');
    // The owner's assignment must be live AND direct — an owner reached
    // through a soft-deleted assignment is not an owner any more.
    expect(sql).toContain(`ra."assignmentType" = 'Direct'`);
    expect(sql).toContain(`ra."deletedAt" IS NULL`);
  });

  it('the single-valued relation has no relation table in either shape', async () => {
    const filterSql = buildRelationshipWhere(
      [{ field: 'rel.manager', value: 'Any (1 or more)' }], 'principals', 'u');
    expect(filterSql).toContain('CASE WHEN u."managerId" IS NOT NULL');
    expect(filterSql).not.toContain('SELECT count');
  });
});

describe('picklists', () => {
  it('single-valued relations only offer None/Any', () => {
    expect(SINGLE_OPTIONS).toEqual(['None (0)', 'Any (1 or more)']);
    expect(MULTI_OPTIONS).toContain('Exactly 1');
    expect(MULTI_OPTIONS).toContain('3 or more');
  });
});
