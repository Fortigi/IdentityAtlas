// Unit tests for the shared `buildFilterWhere` helper.
//
// The helper is used by /api/users and /api/resources to build a
// parameterized WHERE clause from a JSON filter object. Two code paths are
// exercised separately — real columns (validated against a whitelist) and
// `ext.<key>` filters on the `extendedAttributes` JSONB column (validated
// via regex because a JSON path key can't be parameter-bound).

import { describe, it, expect } from 'vitest';
import { buildFilterWhere } from './tags.js';

// Minimal stand-in for the mssql-compat `request` object: records every
// .input() call so we can assert on the parameter bindings.
function fakeRequest() {
  const bound = {};
  return {
    bound,
    input(name, value) { bound[name] = value; return this; },
  };
}

describe('buildFilterWhere — real columns', () => {
  it('emits parameterised equality on a valid column', () => {
    const req = fakeRequest();
    const sql = buildFilterWhere(req, { department: 'Sales' }, new Set(['department']), 'u');
    expect(sql).toBe(' AND u."department"::text = @fl0');
    expect(req.bound).toEqual({ fl0: 'Sales' });
  });

  it('silently drops fields that are not in the whitelist', () => {
    const req = fakeRequest();
    const sql = buildFilterWhere(req, { nopeColumn: 'x' }, new Set(['department']), 'u');
    expect(sql).toBe('');
    expect(req.bound).toEqual({});
  });

  it('skips empty / null / undefined values', () => {
    const req = fakeRequest();
    const sql = buildFilterWhere(
      req,
      { department: '', jobTitle: null, companyName: undefined },
      new Set(['department', 'jobTitle', 'companyName']),
      'u',
    );
    expect(sql).toBe('');
    expect(req.bound).toEqual({});
  });

  it('uses the requested alias and param prefix', () => {
    const req = fakeRequest();
    const sql = buildFilterWhere(req, { resourceType: 'Group' }, new Set(['resourceType']), 'r', 'bf');
    expect(sql).toBe(' AND r."resourceType"::text = @bf0');
    expect(req.bound).toEqual({ bf0: 'Group' });
  });
});

describe('buildFilterWhere — extended-attribute filters', () => {
  it('emits JSON-path SQL for ext.<key> filters', () => {
    const req = fakeRequest();
    const sql = buildFilterWhere(req, { 'ext.userType': 'Guest' }, new Set(), 'u');
    expect(sql).toBe(` AND u."extendedAttributes"->>'userType' = @fl0`);
    expect(req.bound).toEqual({ fl0: 'Guest' });
  });

  it('does NOT require ext keys to be in the column whitelist', () => {
    const req = fakeRequest();
    // validColNames is intentionally empty — ext keys bypass whitelist
    // because they're validated via regex instead.
    const sql = buildFilterWhere(req, { 'ext.onPremisesSyncEnabled': 'true' }, new Set(), 'p');
    expect(sql).toBe(` AND p."extendedAttributes"->>'onPremisesSyncEnabled' = @fl0`);
  });

  it('rejects ext keys containing characters outside [a-zA-Z0-9_]', () => {
    const req = fakeRequest();
    const sql = buildFilterWhere(
      req,
      {
        "ext.badKey'; DROP TABLE--": 'x',
        'ext.bad-dash':              'x',
        'ext.bad.dot':               'x',
        'ext.normalKey':             'ok',
      },
      new Set(),
      'u',
    );
    // Only the safe key survives.
    expect(sql).toBe(` AND u."extendedAttributes"->>'normalKey' = @fl0`);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/bad-dash|bad\.dot/);
    expect(req.bound).toEqual({ fl0: 'ok' });
  });

  it('mixes real columns and ext keys with shared param counter', () => {
    const req = fakeRequest();
    const sql = buildFilterWhere(
      req,
      { department: 'Sales', 'ext.userType': 'Member' },
      new Set(['department']),
      'u',
    );
    // Both filters produced, each with its own @fl<N> binding.
    expect(sql).toMatch(/u\."department"::text = @fl0/);
    expect(sql).toMatch(/u\."extendedAttributes"->>'userType' = @fl1/);
    expect(req.bound).toEqual({ fl0: 'Sales', fl1: 'Member' });
  });
});
