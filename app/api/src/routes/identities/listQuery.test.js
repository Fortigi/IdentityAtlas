// Unit tests for the pure identity-list query helpers (#1034): tag-string
// parsing and WHERE building. The DB-bound summary/columns fetchers and the
// detail phase helpers are covered end-to-end by identities.coverage.test.js.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js'); // manual mock — listQuery pulls in db via shared.js

const { parseTagString, buildIdentityListWhere } = await import('./listQuery.js');

describe('parseTagString', () => {
  it('returns [] for empty input', () => {
    expect(parseTagString('')).toEqual([]);
    expect(parseTagString(null)).toEqual([]);
  });
  it('parses id:name:color triples split on |', () => {
    expect(parseTagString('5:VIP:#fff|6:Ext:#000')).toEqual([
      { id: 5, name: 'VIP', color: '#fff' },
      { id: 6, name: 'Ext', color: '#000' },
    ]);
  });
});

describe('buildIdentityListWhere', () => {
  const binder = () => { let i = 0; return () => `$${++i}`; };

  it('starts from WHERE 1=1 and adds search / minAccounts / confidence', () => {
    const { where } = buildIdentityListWhere(
      { search: 'ann', minAccounts: '3', confidence: '80', attrFilters: {} }, binder(),
    );
    expect(where).toContain('WHERE 1=1');
    expect(where).toContain('"displayName" ILIKE $1');
    expect(where).toContain('"accountCount" >= $2');
    expect(where).toContain('"linkConfidence" >= $3');
  });

  it('ignores minAccounts of 1 (only >1 filters)', () => {
    const { where } = buildIdentityListWhere({ minAccounts: '1', attrFilters: {} }, binder());
    expect(where).not.toContain('accountCount');
  });

  it('applies HR-anchored / orphan clauses only when hasHrCols', () => {
    const on = buildIdentityListWhere({ hrAnchored: 'true', orphanStatus: 'any', attrFilters: {}, hasHrCols: true }, binder()).where;
    expect(on).toContain('"isHrAnchored" = true');
    expect(on).toContain('"orphanStatus" IS NOT NULL');
    const off = buildIdentityListWhere({ hrAnchored: 'true', orphanStatus: 'any', attrFilters: {}, hasHrCols: false }, binder()).where;
    expect(off).not.toContain('isHrAnchored');
  });

  it('binds a specific orphanStatus value', () => {
    const { where } = buildIdentityListWhere({ orphanStatus: 'ExManager', attrFilters: {}, hasHrCols: true }, binder());
    expect(where).toContain('"orphanStatus" = $1');
  });

  it('applies whitelisted attribute filters and skips unknown / empty ones', () => {
    const { where } = buildIdentityListWhere(
      { attrFilters: { department: 'HR', notAColumn: 'x', city: '' } }, binder(),
    );
    expect(where).toContain('"department" = $1');
    expect(where).not.toContain('notAColumn');
    expect(where).not.toContain('"city"');
  });

  it('emits the tag JOIN when a tag filter is set', () => {
    const { identityTagJoin } = buildIdentityListWhere(
      { attrFilters: {}, identityTagFilter: 'vip' }, binder(),
    );
    expect(identityTagJoin).toContain('"GraphTagAssignments" _ita');
    expect(identityTagJoin).toContain(`_it."entityType" = 'identity'`);
  });
});
