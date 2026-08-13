// Unit tests for the pure data-assembly helpers extracted from
// routes/permissions/grid.js (#1028). These need no DB — they cover the request
// parsing, tag extraction, filter validation/splitting, the attribute-filter
// clause factory, and the managedByPackages shaping. The DB-bound runners are
// covered by permissions.coverage.test.js + permissionsGrid.contract.test.js.

import { describe, it, expect } from 'vitest';
import {
  parsePermissionsRequest,
  extractTagFilters,
  splitValidFilters,
  makeFilterClauses,
  shapeManagedByPackages,
} from './gridQuery.js';

// Deterministic binder: returns $1, $2, … so we can assert clause shape.
const fakeBinder = () => { let i = 0; return () => `$${++i}`; };

describe('parsePermissionsRequest', () => {
  it('defaults userLimit to 0 and filters to {}', () => {
    expect(parsePermissionsRequest({ query: {} })).toEqual({ userLimit: 0, requestedFilters: {} });
  });
  it('clamps userLimit to [0, 10000]', () => {
    expect(parsePermissionsRequest({ query: { userLimit: '-5' } }).userLimit).toBe(0);
    expect(parsePermissionsRequest({ query: { userLimit: '99999' } }).userLimit).toBe(10000);
    expect(parsePermissionsRequest({ query: { userLimit: '250' } }).userLimit).toBe(250);
  });
  it('parses a filters JSON object', () => {
    const { requestedFilters } = parsePermissionsRequest({ query: { filters: '{"department":"HR"}' } });
    expect(requestedFilters).toEqual({ department: 'HR' });
  });
  it('ignores malformed filters JSON', () => {
    expect(parsePermissionsRequest({ query: { filters: '{not json' } }).requestedFilters).toEqual({});
  });
});

describe('extractTagFilters', () => {
  it('pulls __userTag / __groupTag out and deletes them from the object', () => {
    const filters = { __userTag: 'vip', __groupTag: 'sensitive', department: 'HR' };
    const tags = extractTagFilters(filters);
    expect(tags).toEqual({ userTagFilter: 'vip', groupTagFilter: 'sensitive' });
    expect(filters).toEqual({ department: 'HR' }); // mutated in place
  });
  it('returns nulls when no tag filters are present', () => {
    expect(extractTagFilters({ department: 'HR' })).toEqual({ userTagFilter: null, groupTagFilter: null });
  });
});

describe('splitValidFilters', () => {
  const colNames = new Set(['department', 'city']);
  const groupColNames = new Set(['resourceDisplayName']);
  it('splits filters into user vs group and drops unknown/empty', () => {
    const { validUserFilters, validGroupFilters } = splitValidFilters(
      { department: 'HR', resourceDisplayName: 'Admins', unknown: 'x', city: '' },
      colNames, groupColNames,
    );
    expect(validUserFilters).toEqual([{ field: 'department', value: 'HR' }]);
    expect(validGroupFilters).toEqual([{ field: 'resourceDisplayName', value: 'Admins' }]);
  });
  it('coerces values to strings', () => {
    const { validUserFilters } = splitValidFilters({ department: 42 }, colNames, groupColNames);
    expect(validUserFilters).toEqual([{ field: 'department', value: '42' }]);
  });
});

describe('makeFilterClauses', () => {
  it('builds user + group WHERE fragments and both tag joins', () => {
    const clauses = makeFilterClauses({
      validUserFilters: [{ field: 'department', value: 'HR' }],
      validGroupFilters: [{ field: 'resourceDisplayName', value: 'Admins' }],
      userTagFilter: 'vip',
      groupTagFilter: 'sensitive',
    });
    const out = clauses(fakeBinder(), { includeUserTag: true });
    expect(out.filterWhere).toContain('u."department"::text = $1');
    // resourceDisplayName aliases back to the real Resources column displayName
    expect(out.groupFilterWhere).toContain('r."displayName"::text = $2');
    expect(out.userTagJoin).toContain('"GraphTags" _ut');
    expect(out.groupTagJoin).toContain(`_gt."entityType" IN ('resource', 'group')`);
  });
  it('suppresses the user-tag join when includeUserTag is false (top-N path)', () => {
    const clauses = makeFilterClauses({
      validUserFilters: [], validGroupFilters: [], userTagFilter: 'vip', groupTagFilter: null,
    });
    const out = clauses(fakeBinder(), { includeUserTag: false });
    expect(out.userTagJoin).toBe('');
    expect(out.groupTagJoin).toBe('');
  });
  it('defaults includeUserTag to true when no options passed', () => {
    const clauses = makeFilterClauses({
      validUserFilters: [], validGroupFilters: [], userTagFilter: 'vip', groupTagFilter: null,
    });
    expect(clauses(fakeBinder()).userTagJoin).toContain('GraphTagAssignments');
  });
});

describe('shapeManagedByPackages', () => {
  it('drops rows without a memberId and splits the id CSV', () => {
    const out = shapeManagedByPackages([
      { memberId: 'u1', resourceId: 'r1', groupId: null, accessPackageIds: 'a,b' },
      { memberId: null, resourceId: 'r2' },
    ]);
    expect(out).toEqual([
      { memberId: 'u1', resourceId: 'r1', groupId: 'r1', accessPackageIds: ['a', 'b'] },
    ]);
  });
  it('falls back between resourceId/groupId and yields [] for no packages', () => {
    const out = shapeManagedByPackages([{ memberId: 'u1', groupId: 'g1', accessPackageIds: null }]);
    expect(out).toEqual([{ memberId: 'u1', resourceId: 'g1', groupId: 'g1', accessPackageIds: [] }]);
  });
});
