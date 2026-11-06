// Unit tests for the pure reconcile helpers (runner.helpers.js).

import { describe, it, expect } from 'vitest';
import { buildNewIdMap, buildMemberInsertBatch, buildRoleInsertBatch, roleKeys, withPluginRoot, PLUGIN_ROOT_EXTERNAL_ID } from './runner.helpers.js';

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

describe('buildRoleInsertBatch', () => {
  const ids = new Map([['mgr-a', 'ctx-a'], ['mgr-b', 'ctx-b']]);

  it('writes one algorithm-owned row per role, with the account or the person as holder', () => {
    const { values, params } = buildRoleInsertBatch([
      { contextExternalId: 'mgr-a', principalId: 'p1', role: 'Accountable' },
      { contextExternalId: 'mgr-b', identityId: 'i1', role: 'Responsible' },
    ], ids);
    expect(values).toEqual(["($1, $2, $3, $4, 'algorithm')", "($5, $6, $7, $8, 'algorithm')"]);
    expect(params).toEqual(['ctx-a', 'p1', null, 'Accountable', 'ctx-b', null, 'i1', 'Responsible']);
  });

  it('skips a dangling context, a role with no holder, and a role with two holders', () => {
    const { values, params } = buildRoleInsertBatch([
      { contextExternalId: 'nowhere', principalId: 'p1', role: 'Accountable' },
      { contextExternalId: 'mgr-a', role: 'Accountable' },
      { contextExternalId: 'mgr-a', principalId: 'p1', identityId: 'i1', role: 'Accountable' },
      { contextExternalId: 'mgr-a', principalId: 'p2', role: 'Responsible' },
    ], ids);
    expect(values).toHaveLength(1);
    expect(params).toEqual(['ctx-a', 'p2', null, 'Responsible']);
  });
});

describe('roleKeys', () => {
  it('lists the (context, holder, role) keys to keep, skipping what would not be inserted', () => {
    const ids = new Map([['a', 'ctx-a'], ['b', 'ctx-b']]);
    expect(roleKeys([
      { contextExternalId: 'a', principalId: 'p1', role: 'Accountable' },
      { contextExternalId: 'b', identityId: 'i1', role: 'Responsible' },
      { contextExternalId: 'gone', principalId: 'p2', role: 'Accountable' },
      { contextExternalId: 'a', principalId: 'p3', identityId: 'i3', role: 'Responsible' },
    ], ids)).toEqual({ ctx: ['ctx-a', 'ctx-b'], holder: ['p1', 'i1'], role: ['Accountable', 'Responsible'] });
  });
});

describe('withPluginRoot', () => {
  const PLUGIN = { displayName: 'Department from Principal', rootDisplayName: 'Departments', contextTypes: ['Department', 'Other'] };
  const ROOT = PLUGIN_ROOT_EXTERNAL_ID;
  const parentsOf = out => Object.fromEntries(out.map(n => [n.externalId, n.parentExternalId ?? null]));

  it('wraps several roots under one root named after the plugin, keeping nested nodes where they are', () => {
    const out = withPluginRoot([
      { externalId: 'dept:Sales', displayName: 'Sales', contextType: 'Department' },
      { externalId: 'dept:Ops', displayName: 'Ops', contextType: 'Department', parentExternalId: 'gone' }, // dangling parent = a root
      { externalId: 'dept:Ops/EU', displayName: 'EU', contextType: 'Department', parentExternalId: 'dept:Ops' },
    ], PLUGIN);
    expect(out[0]).toEqual({ externalId: '__plugin-root__', displayName: 'Departments', contextType: 'Department', description: 'Created by the Department from Principal rule.' });
    expect(parentsOf(out)).toEqual({ [ROOT]: null, 'dept:Sales': ROOT, 'dept:Ops': ROOT, 'dept:Ops/EU': 'dept:Ops' });
  });

  it('names the root after the plugin when it declares no root name', () => {
    const out = withPluginRoot([{ externalId: 'a' }, { externalId: 'b' }], { displayName: 'Risky Consent', contextTypes: ['RiskyConsent'] });
    expect(out[0].displayName).toBe('Risky Consent');
    expect(out[0].contextType).toBe('RiskyConsent');
  });

  it('leaves a single-root tree, and an empty run, unchanged', () => {
    const single = [{ externalId: 'r' }, { externalId: 'c1', parentExternalId: 'r' }, { externalId: 'c2', parentExternalId: 'r' }];
    expect(withPluginRoot(single, PLUGIN)).toBe(single);
    const one = [{ externalId: 'dept:Sales' }];
    expect(withPluginRoot(one, PLUGIN)).toBe(one);
    expect(withPluginRoot([], PLUGIN, true)).toEqual([]);
  });

  it('keeps the root once the tree has it, even when a run is down to one node', () => {
    const out = withPluginRoot([{ externalId: 'dept:Sales' }], PLUGIN, true);
    expect(parentsOf(out)).toEqual({ [ROOT]: null, 'dept:Sales': ROOT });
  });
});
