// Unit tests for the pure reconcile helpers (runner.helpers.js).

import { describe, it, expect } from 'vitest';
import { buildNewIdMap, buildMemberInsertBatch } from './runner.helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('buildNewIdMap', () => {
  it('reuses existing ids and mints UUIDs for new externalIds', () => {
    const existing = new Map([['a', 'id-a']]);
    const map = buildNewIdMap(
      [{ externalId: 'a' }, { externalId: 'b' }],
      existing,
    );
    expect(map.get('a')).toBe('id-a');       // reused
    expect(map.get('b')).toMatch(UUID_RE);   // freshly minted
    expect(map.size).toBe(2);
  });

  it('skips nodes without an externalId', () => {
    const map = buildNewIdMap(
      [{ externalId: '' }, { displayName: 'no ext' }, { externalId: 'keep' }],
      new Map(),
    );
    expect([...map.keys()]).toEqual(['keep']);
  });

  it('is stable for a repeated externalId (last write wins, no duplicates)', () => {
    const map = buildNewIdMap(
      [{ externalId: 'dup' }, { externalId: 'dup' }],
      new Map(),
    );
    expect(map.size).toBe(1);
    expect(map.get('dup')).toMatch(UUID_RE);
  });

  it('returns an empty map for no contexts', () => {
    expect(buildNewIdMap([], new Map()).size).toBe(0);
  });
});

describe('buildMemberInsertBatch', () => {
  const newByExternalId = new Map([['ctx1', 'id-1'], ['ctx2', 'id-2']]);

  it('emits three params + one placeholder tuple per resolvable member', () => {
    const { values, params } = buildMemberInsertBatch(
      [{ contextExternalId: 'ctx1', memberId: 'm1' }, { contextExternalId: 'ctx2', memberId: 'm2' }],
      newByExternalId,
      'Principal',
    );
    expect(values).toEqual([
      "($1, $2, $3, 'algorithm')",
      "($4, $5, $6, 'algorithm')",
    ]);
    expect(params).toEqual(['id-1', 'Principal', 'm1', 'id-2', 'Principal', 'm2']);
  });

  it('silently skips members whose context did not resolve', () => {
    const { values, params } = buildMemberInsertBatch(
      [{ contextExternalId: 'missing', memberId: 'm1' }, { contextExternalId: 'ctx2', memberId: 'm2' }],
      newByExternalId,
      'Resource',
    );
    expect(values).toEqual(["($1, $2, $3, 'algorithm')"]);
    expect(params).toEqual(['id-2', 'Resource', 'm2']);
  });

  it('returns empty arrays when nothing resolves', () => {
    const { values, params } = buildMemberInsertBatch(
      [{ contextExternalId: 'nope', memberId: 'm1' }],
      newByExternalId,
      'Principal',
    );
    expect(values).toEqual([]);
    expect(params).toEqual([]);
  });

  it('numbers placeholders contiguously after a skipped member', () => {
    const { values } = buildMemberInsertBatch(
      [
        { contextExternalId: 'missing', memberId: 'skip' },
        { contextExternalId: 'ctx1', memberId: 'm1' },
      ],
      newByExternalId,
      'Principal',
    );
    // The skipped member consumes no placeholder slots; the survivor starts at $1.
    expect(values).toEqual(["($1, $2, $3, 'algorithm')"]);
  });
});
