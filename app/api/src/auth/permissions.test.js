import { describe, it, expect } from 'vitest';
import { resolvePermissions, isKnownPermission, SEED_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_GROUPS } from './permissions.js';

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

// ── Gaps found by mutation testing ───────────────────────────────────────────
// This file sat at 100% line, branch and function coverage while these four
// mutations survived. Coverage proved the lines ran; nothing proved they were
// right. (Most of this module's other survivors are label/description strings
// in the catalog, which no test should assert — see stryker.auth.config.json.)

describe('seed mapping — the exact grants shipped on a fresh install', () => {
  it('gives Admin the wildcard, not a fixed list', () => {
    // '*' is what makes a newly added permission flow to Admin automatically.
    // Replacing it with any explicit list silently demotes the admin role the
    // next time someone adds a permission to the catalog.
    expect(SEED_ROLE_PERMISSIONS.Admin).toEqual(['*']);
  });

  it('gives RoleMiner read plus both export permissions and nothing more', () => {
    // Widening this on a fresh install hands out access nobody asked for;
    // emptying it locks the role out. Neither is visible from a count.
    expect(SEED_ROLE_PERMISSIONS.RoleMiner)
      .toEqual(['data.read', 'data.export.ui', 'data.export.apikey']);
  });

  it('gives Servicedesk read only', () => {
    expect(SEED_ROLE_PERMISSIONS.Servicedesk).toEqual(['data.read']);
  });

  it('never seeds a role with admin.auth, which would let it re-grant itself', () => {
    for (const [role, granted] of Object.entries(SEED_ROLE_PERMISSIONS)) {
      if (role === 'Admin') continue;
      expect(granted).not.toContain('admin.auth');
      expect(granted).not.toContain('*');
    }
  });
});

describe('PERMISSION_GROUPS', () => {
  it('lists the four groups in display order', () => {
    expect(PERMISSION_GROUPS).toEqual(['Read', 'Export', 'Write', 'Admin']);
  });

  it('covers every group actually used in the catalog', () => {
    const used = new Set(Object.values(PERMISSIONS).map((p) => p.group));
    expect([...used].sort()).toEqual([...PERMISSION_GROUPS].sort());
  });
});

describe('resolvePermissions — absent mapping', () => {
  it('returns an empty Set when the mapping is null', () => {
    // The optional chain in `mapping?.[role]` is load-bearing: without it this
    // throws on a tenant whose role mapping has not been configured yet, which
    // turns a "no permissions" state into a 500 on every authenticated request.
    expect(() => resolvePermissions(['Admin'], null)).not.toThrow();
    expect(resolvePermissions(['Admin'], null).size).toBe(0);
  });

  it('returns an empty Set when the mapping is undefined', () => {
    expect(resolvePermissions(['Admin'], undefined).size).toBe(0);
  });
});
