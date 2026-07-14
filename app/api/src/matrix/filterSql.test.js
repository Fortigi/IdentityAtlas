// Unit tests for matrix/filterSql.js — pure logic, no DB needed.

import { describe, it, expect } from 'vitest';
import { buildEntitySubquery, collectContextIds } from './filterSql.js';
import { createParams } from '../db/sqlParams.js';

const PRINCIPAL_COLS = new Set(['displayName', 'department', 'jobTitle', 'email']);
const CTX_PRINCIPAL  = 'a0000001-0000-0000-0000-000000000001';
const CTX_RESOURCE   = 'a0000002-0000-0000-0000-000000000002';
const CONTEXT_TYPES  = new Map([
  [CTX_PRINCIPAL, 'Principal'],
  [CTX_RESOURCE,  'Resource'],
]);

// Convenience: run buildEntitySubquery for Principals with given conditions.
// Renders through a fresh positional binder and returns the accumulated
// `params` alongside the result so tests can assert on the bound values.
function buildPrincipal(include = [], exclude = []) {
  const { params, bind } = createParams();
  const out = buildEntitySubquery({
    entity: 'Principal',
    include,
    exclude,
    validColumns: PRINCIPAL_COLS,
    contextTypes: CONTEXT_TYPES,
    bind,
  });
  return { ...out, params };
}

describe('buildEntitySubquery', () => {
  it('returns sql=null when no conditions are given', () => {
    const out = buildPrincipal();
    expect(out.sql).toBeNull();
    expect(out.warnings).toHaveLength(0);
  });

  it('returns sql=null for empty include and exclude arrays', () => {
    const out = buildPrincipal([], []);
    expect(out.sql).toBeNull();
  });

  it('generates an IN clause for a single attribute include', () => {
    const out = buildPrincipal([{ kind: 'attribute', field: 'department', values: ['Finance'] }]);
    expect(out.sql).toMatch(/SELECT id FROM "Principals"/);
    expect(out.sql).toMatch(/"department"::text IN/);
    expect(out.params).toContain('Finance');
  });

  it('generates a NOT IN clause for an attribute exclude', () => {
    const out = buildPrincipal([], [{ kind: 'attribute', field: 'department', values: ['Finance'] }]);
    expect(out.sql).toMatch(/IS NOT TRUE/);
  });

  it('ORs multiple values in a single attribute condition', () => {
    const out = buildPrincipal([{ kind: 'attribute', field: 'department', values: ['Finance', 'IT', 'HR'] }]);
    expect(out.params).toHaveLength(3);
    expect(out.sql).toMatch(/"department"::text IN/);
  });

  it('warns and drops an attribute condition for an unknown column', () => {
    const out = buildPrincipal([{ kind: 'attribute', field: 'nonexistent', values: ['x'] }]);
    expect(out.sql).toBeNull();
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/nonexistent/);
  });

  it('generates a context membership subquery for a valid context', () => {
    const out = buildPrincipal([{
      kind: 'context',
      contextId: CTX_PRINCIPAL,
      includeChildren: false,
    }]);
    expect(out.sql).toMatch(/ContextMembers/);
    expect(out.sql).toMatch(/memberType/);
  });

  it('uses recursive CTE when includeChildren is true', () => {
    const out = buildPrincipal([{
      kind: 'context',
      contextId: CTX_PRINCIPAL,
      includeChildren: true,
    }]);
    expect(out.sql).toMatch(/WITH RECURSIVE/);
  });

  it('warns and drops a context with an unknown id', () => {
    const out = buildPrincipal([{ kind: 'context', contextId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', includeChildren: false }]);
    expect(out.sql).toBeNull();
    expect(out.warnings).toHaveLength(1);
  });

  it('warns and drops a context whose targetType is incompatible with the entity', () => {
    // Resource context used on a Principal entity with no IdentityMembers bridge.
    const out = buildPrincipal([{
      kind: 'context',
      contextId: CTX_RESOURCE,
      includeChildren: false,
    }]);
    expect(out.sql).toBeNull();
    expect(out.warnings).toHaveLength(1);
  });
});

describe('collectContextIds', () => {
  it('returns empty array when no context conditions exist', () => {
    const ids = collectContextIds({
      subject:  { include: [{ kind: 'attribute', field: 'department', values: ['x'] }], exclude: [] },
      resource: { include: [], exclude: [] },
    });
    expect(ids).toHaveLength(0);
  });

  it('collects context ids from both subject and resource sides', () => {
    const ids = collectContextIds({
      subject:  { include: [{ kind: 'context', contextId: CTX_PRINCIPAL, includeChildren: false }], exclude: [] },
      resource: { include: [{ kind: 'context', contextId: CTX_RESOURCE, includeChildren: false }], exclude: [] },
    });
    expect(ids.sort()).toEqual([
      CTX_PRINCIPAL,
      CTX_RESOURCE,
    ]);
  });

  it('deduplicates repeated context ids', () => {
    const ids = collectContextIds({
      subject: {
        include: [{ kind: 'context', contextId: CTX_PRINCIPAL, includeChildren: false }],
        exclude: [{ kind: 'context', contextId: CTX_PRINCIPAL, includeChildren: false }],
      },
      resource: { include: [], exclude: [] },
    });
    expect(ids).toHaveLength(1);
  });
});
