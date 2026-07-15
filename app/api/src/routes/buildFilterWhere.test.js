// Unit tests for the shared `buildFilterWhere` helper.
//
// The helper is used by /api/users, /api/groups and /api/resources to build a
// parameterized WHERE fragment from a JSON filter object. Two code paths are
// exercised separately — real columns (validated against a whitelist) and
// `ext.<key>` filters on the `extendedAttributes` JSONB column (validated via
// regex because a JSON path key can't be parameter-bound). Each value is bound
// through the caller's positional `bind` (from createParams).

import { describe, it, expect } from 'vitest';
import { buildFilterWhere } from './tags.js';
import { createParams } from '../db/sqlParams.js';

describe('buildFilterWhere — real columns', () => {
  it('emits parameterised equality on a valid column', () => {
    const { params, bind } = createParams();
    const sql = buildFilterWhere({ department: 'Sales' }, new Set(['department']), 'u', bind);
    expect(sql).toBe(' AND u."department"::text = $1');
    expect(params).toEqual(['Sales']);
  });

  it('silently drops fields that are not in the whitelist', () => {
    const { params, bind } = createParams();
    const sql = buildFilterWhere({ nopeColumn: 'x' }, new Set(['department']), 'u', bind);
    expect(sql).toBe('');
    expect(params).toEqual([]);
  });

  it('skips empty / null / undefined values', () => {
    const { params, bind } = createParams();
    const sql = buildFilterWhere(
      { department: '', jobTitle: null, companyName: undefined },
      new Set(['department', 'jobTitle', 'companyName']),
      'u', bind,
    );
    expect(sql).toBe('');
    expect(params).toEqual([]);
  });

  it('uses the requested alias', () => {
    const { params, bind } = createParams();
    const sql = buildFilterWhere({ resourceType: 'Group' }, new Set(['resourceType']), 'r', bind);
    expect(sql).toBe(' AND r."resourceType"::text = $1');
    expect(params).toEqual(['Group']);
  });
});

describe('buildFilterWhere — extended-attribute filters', () => {
  it('emits JSON-path SQL for ext.<key> filters', () => {
    const { params, bind } = createParams();
    const sql = buildFilterWhere({ 'ext.userType': 'Guest' }, new Set(), 'u', bind);
    expect(sql).toBe(` AND u."extendedAttributes"->>'userType' = $1`);
    expect(params).toEqual(['Guest']);
  });

  it('does NOT require ext keys to be in the column whitelist', () => {
    const { params, bind } = createParams();
    // validColNames is intentionally empty — ext keys bypass the whitelist
    // because they're validated via regex instead.
    const sql = buildFilterWhere({ 'ext.onPremisesSyncEnabled': 'true' }, new Set(), 'p', bind);
    expect(sql).toBe(` AND p."extendedAttributes"->>'onPremisesSyncEnabled' = $1`);
    expect(params).toEqual(['true']);
  });

  it('rejects ext keys containing characters outside [a-zA-Z0-9_]', () => {
    const { params, bind } = createParams();
    const sql = buildFilterWhere(
      {
        "ext.badKey'; DROP TABLE--": 'x',
        'ext.bad-dash':              'x',
        'ext.bad.dot':               'x',
        'ext.normalKey':             'ok',
      },
      new Set(), 'u', bind,
    );
    // Only the safe key survives.
    expect(sql).toBe(` AND u."extendedAttributes"->>'normalKey' = $1`);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/bad-dash|bad\.dot/);
    expect(params).toEqual(['ok']);
  });

  it('mixes real columns and ext keys sharing one positional counter', () => {
    const { params, bind } = createParams();
    const sql = buildFilterWhere(
      { department: 'Sales', 'ext.userType': 'Member' },
      new Set(['department']),
      'u', bind,
    );
    expect(sql).toMatch(/u\."department"::text = \$1/);
    expect(sql).toMatch(/u\."extendedAttributes"->>'userType' = \$2/);
    expect(params).toEqual(['Sales', 'Member']);
  });

  it("continues the caller's existing param sequence", () => {
    const { params, bind } = createParams();
    bind('preexisting'); // $1 already taken by the enclosing query
    const sql = buildFilterWhere({ department: 'Sales' }, new Set(['department']), 'u', bind);
    expect(sql).toBe(' AND u."department"::text = $2');
    expect(params).toEqual(['preexisting', 'Sales']);
  });
});
