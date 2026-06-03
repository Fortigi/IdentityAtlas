import { describe, it, expect } from 'vitest';
import { resolvePermissions, isKnownPermission, SEED_ROLE_PERMISSIONS, PERMISSIONS } from './permissions.js';

describe('permissions catalog', () => {
  it('seeds Admin / RoleMiner / Servicedesk', () => {
    expect(Object.keys(SEED_ROLE_PERMISSIONS).sort()).toEqual(['Admin', 'RoleMiner', 'Servicedesk']);
  });

  it('every non-wildcard seed permission is in the catalog', () => {
    for (const perms of Object.values(SEED_ROLE_PERMISSIONS)) {
      for (const p of perms) {
        expect(p === '*' || PERMISSIONS[p], `unknown perm in seed: ${p}`).toBeTruthy();
      }
    }
  });

  it('isKnownPermission accepts the wildcard and any catalog key', () => {
    expect(isKnownPermission('*')).toBe(true);
    expect(isKnownPermission('data.read')).toBe(true);
    expect(isKnownPermission('admin.auth')).toBe(true);
    expect(isKnownPermission('something.invented')).toBe(false);
    expect(isKnownPermission('')).toBe(false);
  });
});

describe('resolvePermissions', () => {
  const mapping = {
    Admin: ['*'],
    RoleMiner: ['data.read', 'data.export.ui', 'data.export.apikey'],
    Servicedesk: ['data.read'],
  };

  it('returns an empty Set for no roles', () => {
    expect(resolvePermissions([], mapping).size).toBe(0);
    expect(resolvePermissions(null, mapping).size).toBe(0);
    expect(resolvePermissions(undefined, mapping).size).toBe(0);
  });

  it('expands wildcard to every catalog permission', () => {
    const perms = resolvePermissions(['Admin'], mapping);
    expect(perms.has('*')).toBe(true);
    for (const k of Object.keys(PERMISSIONS)) {
      expect(perms.has(k), `Admin wildcard should include ${k}`).toBe(true);
    }
  });

  it('grants only the listed permissions for a non-wildcard role', () => {
    const perms = resolvePermissions(['Servicedesk'], mapping);
    expect(perms.has('data.read')).toBe(true);
    expect(perms.has('data.export.ui')).toBe(false);
    expect(perms.has('admin.auth')).toBe(false);
  });

  it('unions permissions across multiple roles', () => {
    const perms = resolvePermissions(['Servicedesk', 'RoleMiner'], mapping);
    expect(perms.has('data.read')).toBe(true);
    expect(perms.has('data.export.ui')).toBe(true);
    expect(perms.has('data.export.apikey')).toBe(true);
    expect(perms.has('admin.auth')).toBe(false);
  });

  it('silently drops roles that are not in the mapping', () => {
    const perms = resolvePermissions(['Servicedesk', 'UnknownRole'], mapping);
    expect(perms.has('data.read')).toBe(true);
    expect(perms.size).toBe(1);
  });

  it('silently drops permission strings that are not in the catalog', () => {
    const badMapping = { Weird: ['data.read', 'made.up.permission'] };
    const perms = resolvePermissions(['Weird'], badMapping);
    expect(perms.has('data.read')).toBe(true);
    expect(perms.has('made.up.permission')).toBe(false);
  });
});
