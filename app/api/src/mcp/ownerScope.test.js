// Who is a context owner for MCP, and the `scope` block every result carries.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection.js');
const { resolveMcpContextOwner, scopeOf, rowScopeOf, OWNER_SCOPE_DESCRIPTION, ROLE_SCOPE_DESCRIPTION } = await import('./ownerScope.js');

const MINE = 'a0000000-0000-4000-8000-000000000001';
const SUB = 'a0000000-0000-4000-8000-000000000002';
const OWNER = {
  contexts: [{ id: MINE, displayName: 'CTO (Carla Cash)', role: 'Accountable', contextCategory: 'OrganizationalUnit', targetType: 'Principal' }],
  contextIds: new Set([MINE, SUB]),
};

describe('resolveMcpContextOwner', () => {
  it('does not even look the caller up while the switches are off', async () => {
    const resolve = vi.fn();
    expect(await resolveMcpContextOwner({ oid: 'x' }, { enabled: async () => false, resolve })).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('is null for someone who answers for no context', async () => {
    expect(await resolveMcpContextOwner({ oid: 'x' }, { enabled: async () => true, resolve: async () => null })).toBeNull();
  });

  it('carries the contexts, an access service over the scope and the row scope for queries', async () => {
    const owner = await resolveMcpContextOwner({ oid: 'x' }, { enabled: async () => true, resolve: async () => OWNER });
    expect(owner.contexts).toBe(OWNER.contexts);
    expect([...owner.access.contextIds].sort()).toEqual([MINE, SUB]);
    expect(owner.rowScope).toEqual({ basis: 'context-owner', contextIds: [MINE, SUB] });
  });

  it('lets a failing lookup through to the caller, which fails closed', async () => {
    await expect(resolveMcpContextOwner({}, { enabled: async () => true, resolve: async () => { throw new Error('db down'); } }))
      .rejects.toThrow('db down');
  });
});

describe('scopeOf / rowScopeOf', () => {
  it('says an analyst\'s results are not restricted, and there is no row scope', () => {
    const ctx = { user: { permissions: new Set(['*']) } };
    expect(scopeOf(ctx)).toEqual({ restricted: false, basis: 'role', description: ROLE_SCOPE_DESCRIPTION });
    expect(rowScopeOf(ctx)).toBeNull();
    expect(rowScopeOf(undefined)).toBeNull();
  });

  it('says an owner\'s results are restricted, names their own contexts, and never a figure about the rest', () => {
    const ctx = { user: { contextOwner: { ...OWNER, rowScope: { contextIds: [MINE] } } } };
    const s = scopeOf(ctx);
    expect(s).toEqual({
      restricted: true, basis: 'context-owner', description: OWNER_SCOPE_DESCRIPTION,
      contexts: [{ id: MINE, name: 'CTO (Carla Cash)', role: 'Accountable' }],
    });
    expect(s.description).toMatch(/not figures for the whole organisation/);
    // No number anywhere in the block: nothing about the size of what lies outside.
    expect(Object.values(s).some(v => typeof v === 'number')).toBe(false);
    expect(rowScopeOf(ctx)).toEqual({ contextIds: [MINE] });
  });
});
