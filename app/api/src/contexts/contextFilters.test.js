import { describe, it, expect } from 'vitest';
import { buildContextFilterSql, parseAndResolveContextFilters } from './contextFilters.js';
import { createParams } from '../db/sqlParams.js';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

// Render through a fresh positional binder and return the accumulated `params`
// alongside the clauses so tests can assert on the bound values ($N tokens).
function build(resolvedFilters) {
  const { params, bind } = createParams();
  const out = buildContextFilterSql(resolvedFilters, bind);
  return { ...out, params };
}

describe('buildContextFilterSql', () => {
  it('returns empty on empty input', () => {
    const out = build([]);
    expect(out.principalClauses).toEqual([]);
    expect(out.resourceClauses).toEqual([]);
    expect(out.innerPrincipalClauses).toEqual([]);
    expect(out.innerResourceClauses).toEqual([]);
    expect(out.params).toEqual([]);
  });

  it('emits unaliased inner clauses alongside aliased outer ones for Principal filters', () => {
    // The inner clauses get inlined into the top-N subquery in permissions.js
    // where "principalId" has no alias — no `p.` prefix is allowed.
    const out = build([
      { id: UUID_A, includeChildren: false, targetType: 'Principal' },
    ]);
    expect(out.principalClauses[0]).toMatch(/^p\."principalId" IN/);
    expect(out.innerPrincipalClauses).toHaveLength(1);
    expect(out.innerPrincipalClauses[0]).toMatch(/^"principalId" IN/);
    expect(out.innerPrincipalClauses[0]).not.toMatch(/p\./);
  });

  it('emits unaliased inner resource clause for Resource filters', () => {
    const out = build([
      { id: UUID_A, includeChildren: true, targetType: 'Resource' },
    ]);
    expect(out.resourceClauses[0]).toMatch(/^r\.id IN/);
    expect(out.innerResourceClauses).toHaveLength(1);
    // Top-N subquery reads from vw_ResourceUserPermissionAssignments which
    // exposes "resourceId" (not r.id).
    expect(out.innerResourceClauses[0]).toMatch(/^"resourceId" IN/);
  });

  it('does not emit an inner clause for System filters (view has no systemId)', () => {
    const out = build([
      { id: UUID_A, includeChildren: false, targetType: 'System' },
    ]);
    expect(out.resourceClauses).toHaveLength(1);
    expect(out.innerResourceClauses).toHaveLength(0);
  });

  it('generates a principal clause for Identity target', () => {
    const out = build([
      { id: UUID_A, includeChildren: false, targetType: 'Identity' },
    ]);
    expect(out.principalClauses).toHaveLength(1);
    expect(out.resourceClauses).toHaveLength(0);
    expect(out.principalClauses[0]).toMatch(/p\."principalId" IN/);
    // Each filter binds its id then its member-type, in order.
    expect(out.params).toEqual([UUID_A, 'Identity']);
    // Flat variant — no WITH RECURSIVE
    expect(out.principalClauses[0]).not.toMatch(/WITH RECURSIVE/);
  });

  it('generates a recursive CTE when includeChildren=true', () => {
    const out = build([
      { id: UUID_A, includeChildren: true, targetType: 'Identity' },
    ]);
    expect(out.principalClauses[0]).toMatch(/WITH RECURSIVE scope/);
    expect(out.principalClauses[0]).toMatch(/SELECT id FROM "Contexts"/);
  });

  it('routes Resource targets to the resource side', () => {
    const out = build([
      { id: UUID_A, includeChildren: false, targetType: 'Resource' },
    ]);
    expect(out.principalClauses).toHaveLength(0);
    expect(out.resourceClauses).toHaveLength(1);
    expect(out.resourceClauses[0]).toMatch(/^r\.id IN/);
  });

  it('routes System targets to r.systemId', () => {
    const out = build([
      { id: UUID_A, includeChildren: false, targetType: 'System' },
    ]);
    expect(out.resourceClauses).toHaveLength(1);
    expect(out.resourceClauses[0]).toMatch(/r\."systemId"::text IN/);
  });

  it('issues unique placeholders per filter', () => {
    const out = build([
      { id: UUID_A, includeChildren: false, targetType: 'Identity' },
      { id: UUID_B, includeChildren: true,  targetType: 'Resource' },
    ]);
    // Filter 0 binds id→$1, mem→$2; filter 1 binds id→$3, mem→$4.
    expect(out.params[0]).toBe(UUID_A);
    expect(out.params[2]).toBe(UUID_B);
    expect(out.principalClauses[0]).toContain('$1');
    expect(out.resourceClauses[0]).toContain('$3');
  });

  it('silently drops filters with invalid UUIDs', () => {
    const out = build([
      { id: 'not-a-uuid', includeChildren: false, targetType: 'Identity' },
      { id: UUID_A,       includeChildren: false, targetType: 'Identity' },
    ]);
    expect(out.principalClauses).toHaveLength(1);
    // Only the valid filter bound anything — the invalid one was skipped
    // before it could bind an id or member-type.
    expect(out.params).toEqual([UUID_A, 'Identity']);
  });
});

describe('parseAndResolveContextFilters', () => {
  const fakeFetch = async (ids) => ids.map(id => ({
    id,
    targetType: id === UUID_A ? 'Identity' : 'Resource',
  }));

  it('returns [] on missing input', async () => {
    expect(await parseAndResolveContextFilters(null, fakeFetch)).toEqual([]);
    expect(await parseAndResolveContextFilters('', fakeFetch)).toEqual([]);
    expect(await parseAndResolveContextFilters(undefined, fakeFetch)).toEqual([]);
  });

  it('returns [] on malformed JSON', async () => {
    expect(await parseAndResolveContextFilters('not-json', fakeFetch)).toEqual([]);
  });

  it('parses a JSON string and resolves targetType', async () => {
    const raw = JSON.stringify([{ id: UUID_A, includeChildren: true }]);
    const out = await parseAndResolveContextFilters(raw, fakeFetch);
    expect(out).toEqual([
      { id: UUID_A, includeChildren: true, targetType: 'Identity' },
    ]);
  });

  it('accepts an already-parsed array', async () => {
    const out = await parseAndResolveContextFilters(
      [{ id: UUID_B, includeChildren: false }],
      fakeFetch,
    );
    expect(out).toEqual([
      { id: UUID_B, includeChildren: false, targetType: 'Resource' },
    ]);
  });

  it('drops entries whose ids could not be resolved', async () => {
    const noResolveFetch = async () => [];
    const out = await parseAndResolveContextFilters(
      [{ id: UUID_A, includeChildren: false }],
      noResolveFetch,
    );
    expect(out).toEqual([]);
  });

  it('coerces includeChildren to bool', async () => {
    const out = await parseAndResolveContextFilters(
      [{ id: UUID_A, includeChildren: 'true' }],
      fakeFetch,
    );
    expect(out[0].includeChildren).toBe(true);
  });
});
