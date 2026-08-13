// Unit tests for the pure GET /api/resources list helpers (#1033): param/filter
// parsing, WHERE building, and row mapping. The DB-bound detail helpers live in
// resourceDetail.js and are covered by resources.test.js + resources.contract.test.js.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js'); // manual mock — the imported route helpers pull in db

const { parseResourceListParams, buildResourceListWhere, mapResourceRow } = await import('./list.js');

describe('parseResourceListParams', () => {
  it('trims + clamps and defaults', () => {
    const p = parseResourceListParams({ query: { search: '  hi  ', limit: '5', offset: '10' } });
    expect(p).toMatchObject({ search: 'hi', limit: 5, offset: 10 });
  });
  it('clamps limit to [1, 10000], defaults 0/blank to 100, and offset to >= 0', () => {
    expect(parseResourceListParams({ query: { limit: '99999' } }).limit).toBe(10000);
    expect(parseResourceListParams({ query: { limit: '0' } }).limit).toBe(100);  // 0 is falsy → default 100
    expect(parseResourceListParams({ query: { limit: '-5' } }).limit).toBe(1);   // negative clamps up to 1
    expect(parseResourceListParams({ query: {} }).limit).toBe(100);
    expect(parseResourceListParams({ query: { offset: '-3' } }).offset).toBe(0);
  });
  it('pulls __resourceTag out of the attribute filters', () => {
    const p = parseResourceListParams({ query: { filters: '{"dept":"HR","__resourceTag":"vip"}' } });
    expect(p.resourceTagFilter).toBe('vip');
    expect(p.attrFilters).toEqual({ dept: 'HR' });
  });
  it('falls back to __groupTag for backward compat', () => {
    expect(parseResourceListParams({ query: { filters: '{"__groupTag":"g"}' } }).resourceTagFilter).toBe('g');
  });
  it('ignores malformed filters JSON', () => {
    expect(parseResourceListParams({ query: { filters: '{bad' } }).attrFilters).toEqual({});
  });
});

describe('buildResourceListWhere', () => {
  const binder = () => { let i = 0; return () => `$${++i}`; };

  it('builds search / type / system / tag clauses and hides soft-deleted', () => {
    const req = { query: { search: 'x', resourceType: 'Group', systemId: '3', tagId: 't1' } };
    const { where, resourceTagJoin } = buildResourceListWhere(req, parseResourceListParams(req), new Set(), binder());
    expect(where).toContain('r."deletedAt" IS NULL');
    expect(where).toContain('r."displayName" ILIKE $1');
    expect(where).toContain('r."resourceType" = $2');
    expect(where).toContain('r."systemId" = $3');
    expect(where).toContain('"GraphTagAssignments"');
    expect(resourceTagJoin).toBe('');
  });
  it('excludes business roles by default (no resourceType) and honours includeDeleted', () => {
    const req = { query: { includeDeleted: 'true' } };
    const { where } = buildResourceListWhere(req, parseResourceListParams(req), new Set(), binder());
    expect(where).not.toContain('deletedAt');
    expect(where).toContain(`r."resourceType" <> 'BusinessRole'`);
  });
  it('emits a tag-filter JOIN when __resourceTag is set', () => {
    const req = { query: { filters: '{"__resourceTag":"vip"}' } };
    const { resourceTagJoin } = buildResourceListWhere(req, parseResourceListParams(req), new Set(), binder());
    expect(resourceTagJoin).toContain('"GraphTagAssignments" _rta');
  });
});

describe('mapResourceRow', () => {
  it('parses extAttrs, strips tagString, and adds group* aliases', () => {
    const out = mapResourceRow({
      id: 'r1', displayName: 'Grp', description: 'd', resourceType: 'Group',
      extendedAttributes: { a: 1 }, tagString: null, riskScore: 5,
    });
    expect(out).toMatchObject({
      id: 'r1', displayName: 'Grp', riskScore: 5, extendedAttributes: { a: 1 },
      groupId: 'r1', groupDisplayName: 'Grp', groupDescription: 'd', groupTypeCalculated: 'Group',
    });
    expect(out.tagString).toBeUndefined();
    expect(Array.isArray(out.tags)).toBe(true);
  });
});
