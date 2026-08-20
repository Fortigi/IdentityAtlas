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

// ── Context filters across entity types ─────────────────────────────────────
// A context filter names a set of members; the entity being filtered is often a
// different kind of thing, so the filter has to be translated. Every translation
// was unasserted: the tests above only ever put a Principal context on a Principal
// entity (the direct case) or an incompatible one (dropped with a warning), so all
// three cross-entity mappings could have been wrong or missing and nothing failed.
//
// A wrong translation here is the worst kind of silent: the query still runs and
// still returns rows, they are simply the wrong people. Two of the mappings are
// exact mirror images of each other — principal→identity and identity→principal
// differ only in which column is selected and which is matched — so each test
// asserts the DIRECTION, not merely that IdentityMembers is involved.
describe('context filters across entity types', () => {
  const CTX_IDENTITY = 'a0000003-0000-0000-0000-000000000003';
  const CTX_SYSTEM   = 'a0000004-0000-0000-0000-000000000004';
  const TYPES = new Map([
    [CTX_PRINCIPAL, 'Principal'],
    [CTX_RESOURCE,  'Resource'],
    [CTX_IDENTITY,  'Identity'],
    [CTX_SYSTEM,    'System'],
  ]);

  const buildFor = (entity, contextId) => {
    const { params, bind } = createParams();
    const out = buildEntitySubquery({
      entity,
      include: [{ kind: 'context', contextId, includeChildren: false }],
      exclude: [],
      validColumns: new Set(),
      contextTypes: TYPES,
      bind,
    });
    return { ...out, params, norm: (out.sql || '').replace(/\s+/g, ' ').trim() };
  };

  it('matches ids directly when the context already targets this entity', () => {
    const out = buildFor('Principal', CTX_PRINCIPAL);
    // No bridge table: the context members ARE the entities being filtered.
    expect(out.norm).toContain('id IN ( SELECT "memberId" FROM "ContextMembers"');
    expect(out.norm).not.toContain('IdentityMembers');
  });

  it('expands an Identity context down to its member principals', () => {
    const out = buildFor('Principal', CTX_IDENTITY);
    // Selects principalId, matches on identityId — the opposite of the roll-up
    // below. Asserting both columns is what distinguishes the two directions;
    // "uses IdentityMembers" is true of either and so proves nothing.
    expect(out.norm).toContain('id IN (SELECT "principalId" FROM "IdentityMembers" WHERE "identityId" IN');
  });

  it('rolls a Principal context up to the identities those principals belong to', () => {
    const out = buildFor('Identity', CTX_PRINCIPAL);
    expect(out.norm).toContain('id IN (SELECT "identityId" FROM "IdentityMembers" WHERE "principalId" IN');
  });

  it('matches resources by system id for a System context', () => {
    const out = buildFor('Resource', CTX_SYSTEM);
    // Not `id IN` — a System context constrains which system a resource belongs
    // to, so it filters on systemId, cast because ContextMembers.memberId is text.
    expect(out.norm).toContain('"systemId"::text IN (');
    expect(out.norm).not.toContain('IdentityMembers');
  });

  // Every entity/context pairing that has NO translation. This table has to cover
  // each unusable pairing, not a sample of them: each mapping above is guarded by
  // two conditions, and only a pairing that satisfies one of them proves the other
  // is load-bearing. Resource+Identity and Principal+System are here for exactly
  // that reason — without them, dropping the `entity` half of either guard changes
  // nothing any test can see.
  it.each([
    ['Principal', 'Resource', CTX_RESOURCE],
    ['Identity',  'Resource', CTX_RESOURCE],
    ['Resource',  'Principal', CTX_PRINCIPAL],
    ['Resource',  'Identity', CTX_IDENTITY],
    ['Principal', 'System', CTX_SYSTEM],
    ['Identity',  'System', CTX_SYSTEM],
  ])('drops a %s filter carrying an unusable %s context, with a warning', (entity, _kind, contextId) => {
    const out = buildFor(entity, contextId);
    // Dropped rather than ignored: silently returning every row would widen the
    // filter to everything, which reads as "no matches were excluded".
    expect(out.sql).toBeNull();
    expect(out.warnings).toHaveLength(1);
  });
});

// ── Include vs exclude routing ──────────────────────────────────────────────
// Every condition is pushed onto one of two lists by `target === 'inc'`, and the
// exclude list is the one wrapped in `IS NOT TRUE`. Send a condition down the
// wrong branch and the filter does the opposite of what was asked: the rows the
// user wanted hidden are the only ones they see.
//
// The existing tests could not detect that. The include test asserts
// `"department"::text IN` — which is still in the SQL when the condition is
// routed to exclude, because the wrapper goes AROUND it. Each direction has to
// assert the wrapper's presence AND its absence.
describe('include and exclude routing', () => {
  const attrCond = { kind: 'attribute', field: 'department', values: ['Finance'] };
  const ctxCond = { kind: 'context', contextId: CTX_PRINCIPAL, includeChildren: false };

  it('leaves an attribute include unwrapped', () => {
    const out = buildPrincipal([attrCond], []);
    expect(out.sql).toContain('"department"::text IN');
    expect(out.sql).not.toContain('IS NOT TRUE');
  });

  it('wraps an attribute exclude so NULL attributes are kept', () => {
    const out = buildPrincipal([], [attrCond]);
    expect(out.sql).toContain('"department"::text IN');
    expect(out.sql).toContain('IS NOT TRUE');
  });

  it('leaves a context include unwrapped', () => {
    const out = buildPrincipal([ctxCond], []);
    expect(out.sql).toContain('ContextMembers');
    expect(out.sql).not.toContain('IS NOT TRUE');
  });

  it('wraps a context exclude', () => {
    // Excluding by context was never exercised at all — only attributes were.
    const out = buildPrincipal([], [ctxCond]);
    expect(out.sql).toContain('ContextMembers');
    expect(out.sql).toContain('IS NOT TRUE');
  });

  it('keeps both sides apart when a filter includes and excludes at once', () => {
    const out = buildPrincipal(
      [{ kind: 'attribute', field: 'department', values: ['Finance'] }],
      [{ kind: 'attribute', field: 'jobTitle', values: ['Intern'] }],
    );
    // The included field is bare; only the excluded one carries the wrapper. A
    // routing bug that sent both the same way collapses this asymmetry.
    expect(out.sql).toMatch(/"department"::text IN \([^)]*\) AND \("jobTitle"::text IN/);
    expect(out.sql).toContain('IS NOT TRUE');
    expect(out.sql.match(/IS NOT TRUE/g)).toHaveLength(1);
  });
});

// ── collectContextIds only collects real context ids ────────────────────────
// This prefetches the context types the filter will need. Its guard rejects
// anything that is not a context condition carrying a UUID string; loosen it and
// the caller looks up ids that cannot exist — or, with `c || c.kind`, dereferences
// a null condition. Nothing malformed was ever passed in, so the whole guard was
// unmeasured.
describe('collectContextIds rejects malformed conditions', () => {
  it('collects only the well-formed context ids from a mixed list', () => {
    const ids = collectContextIds({
      subject: {
        include: [
          null,                                                            // no condition at all
          { kind: 'attribute', field: 'department', values: ['Finance'] }, // not a context
          { kind: 'context', contextId: 12345 },                           // id is not a string
          { kind: 'context', contextId: 'not-a-uuid' },                    // string, but not an id
          // Two inputs that differ from a valid one in EXACTLY one property, so
          // each check is provably load-bearing. Both are shapes real JSON
          // produces: a condition mis-tagged as an attribute while still carrying
          // its context id, and an id wrapped in the single-element array that a
          // multi-select control emits.
          { kind: 'attribute', field: 'department', contextId: CTX_RESOURCE, values: [] },
          { kind: 'context', contextId: [CTX_RESOURCE] },
          { kind: 'context', contextId: CTX_PRINCIPAL },                   // the only valid one
        ],
        exclude: [],
      },
      resource: { include: [], exclude: [] },
    });
    // Exactly one survivor, named — four different ways of being malformed, so a
    // guard that drops any one of its four checks admits a different id here.
    expect(ids).toEqual([CTX_PRINCIPAL]);
  });

  it('ignores a side that is not an array', () => {
    const ids = collectContextIds({
      subject: { include: 'nonsense', exclude: null },
      resource: { include: [{ kind: 'context', contextId: CTX_RESOURCE }], exclude: [] },
    });
    expect(ids).toEqual([CTX_RESOURCE]);
  });
});
