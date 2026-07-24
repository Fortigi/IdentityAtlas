import { describe, it, expect } from 'vitest';
import {
  buildRelationshipWhere,
  extractRelFilters,
  storeForEntityType,
  MULTI_OPTIONS,
  SINGLE_OPTIONS,
} from './referenceFilters.js';

describe('extractRelFilters', () => {
  it('pulls rel.* keys out and mutates the source object', () => {
    const attr = { department: 'IT', 'rel.owners': 'None (0)', 'ext.userType': 'Member' };
    const rel = extractRelFilters(attr);
    expect(rel).toEqual({ 'rel.owners': 'None (0)' });
    expect(attr).toEqual({ department: 'IT', 'ext.userType': 'Member' });
  });

  it('returns {} when there are no rel keys', () => {
    const attr = { department: 'IT' };
    expect(extractRelFilters(attr)).toEqual({});
    expect(attr).toEqual({ department: 'IT' });
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
      const sql = buildRelationshipWhere({ 'rel.owners': value }, 'principals', 'u');
      expect(sql).toContain('PrincipalRelationships');
      expect(sql.trim().endsWith(expected)).toBe(true);
    });
  }

  it('references the subject alias in the correlated subquery', () => {
    const sql = buildRelationshipWhere({ 'rel.members': 'Any (1 or more)' }, 'resources', 'r');
    expect(sql).toContain('ResourceAssignments');
    expect(sql).toContain('r.id');
  });

  it('composes multiple rel filters', () => {
    const sql = buildRelationshipWhere(
      { 'rel.owners': 'None (0)', 'rel.directReports': '2 or more' },
      'principals', 'u',
    );
    expect(sql).toContain('= 0');
    expect(sql).toContain('>= 2');
  });
});

describe('buildRelationshipWhere — fail closed', () => {
  it('unknown rel key → AND 1=0 (never widens results)', () => {
    expect(buildRelationshipWhere({ 'rel.bogus': 'None (0)' }, 'principals', 'u')).toBe(' AND 1=0');
  });

  it('unrecognised value → AND 1=0', () => {
    expect(buildRelationshipWhere({ 'rel.owners': "'; DROP TABLE" }, 'principals', 'u')).toBe(' AND 1=0');
  });

  it('count operator on a single-valued relation (manager) → AND 1=0', () => {
    expect(buildRelationshipWhere({ 'rel.manager': '2 or more' }, 'principals', 'u')).toBe(' AND 1=0');
  });

  it('single-valued None/Any are allowed', () => {
    expect(buildRelationshipWhere({ 'rel.manager': 'None (0)' }, 'principals', 'u')).toContain('= 0');
    expect(buildRelationshipWhere({ 'rel.manager': 'Any (1 or more)' }, 'principals', 'u')).toContain('>= 1');
  });

  it('unknown table with rel filters → AND 1=0', () => {
    expect(buildRelationshipWhere({ 'rel.owners': 'None (0)' }, 'widgets', 'w')).toBe(' AND 1=0');
  });

  it('unsafe alias with rel filters → AND 1=0', () => {
    expect(buildRelationshipWhere({ 'rel.owners': 'None (0)' }, 'principals', 'u; --')).toBe(' AND 1=0');
  });

  it('empty rel filters → empty string (no clause)', () => {
    expect(buildRelationshipWhere({}, 'principals', 'u')).toBe('');
    expect(buildRelationshipWhere(null, 'principals', 'u')).toBe('');
  });

  it('a field from the wrong table is rejected (rel.members on principals)', () => {
    expect(buildRelationshipWhere({ 'rel.members': 'Any (1 or more)' }, 'principals', 'u')).toBe(' AND 1=0');
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

describe('picklists', () => {
  it('single-valued relations only offer None/Any', () => {
    expect(SINGLE_OPTIONS).toEqual(['None (0)', 'Any (1 or more)']);
    expect(MULTI_OPTIONS).toContain('Exactly 1');
    expect(MULTI_OPTIONS).toContain('3 or more');
  });
});
