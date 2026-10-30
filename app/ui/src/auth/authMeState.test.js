// Unit tests for the /api/auth-me → permission-state mapping.
//
// This decides what the whole UI believes the signed-in user may do, so the
// cases below are the ones where a plausible wrong implementation would be
// dangerous rather than merely wrong: a degraded response that reads as admin,
// or a missing field that defaults the wrong way.

import { describe, it, expect } from 'vitest';
import { degradedPermState, permStateFromAuthMe, isContextOwnerSession } from './authMeState';

describe('degradedPermState', () => {
  it('fails closed — no permissions, no wildcard', () => {
    const s = degradedPermState();
    expect(s.permissions.size).toBe(0);
    // The important half: an empty permission set WITH a wildcard would show
    // every write control to a user whose rights could not be established.
    expect(s.hasWildcard).toBe(false);
    expect(s.roles).toEqual([]);
  });

  it('is marked loaded, so the UI stops waiting', () => {
    // Left false, the app sits on its loading state forever after a failed
    // auth call instead of rendering in its safe, read-only shape.
    expect(degradedPermState().loaded).toBe(true);
  });

  it('carries no identity mapping', () => {
    expect(degradedPermState().me).toBeNull();
  });
});

describe('permStateFromAuthMe', () => {
  it('maps a full response', () => {
    const me = { principal: { id: 'p1' }, identity: { id: 'i1' }, matchedOn: 'oid' };
    const s = permStateFromAuthMe({
      permissions: ['data.read', 'admin.crawlers'], roles: ['Admin'], hasWildcard: true, me,
    });

    expect([...s.permissions]).toEqual(['data.read', 'admin.crawlers']);
    expect(s.roles).toEqual(['Admin']);
    expect(s.hasWildcard).toBe(true);
    expect(s.me).toEqual(me);
    expect(s.loaded).toBe(true);
  });

  it('turns permissions into a Set for membership checks', () => {
    // Consumers call .has(); an array would silently answer undefined.
    const s = permStateFromAuthMe({ permissions: ['data.read'] });
    expect(s.permissions).toBeInstanceOf(Set);
    expect(s.permissions.has('data.read')).toBe(true);
  });

  it('defaults every field on an empty response', () => {
    // Open mode and the pre-schema bootstrap both answer with fields missing.
    const s = permStateFromAuthMe({});
    expect(s.permissions.size).toBe(0);
    expect(s.roles).toEqual([]);
    expect(s.hasWildcard).toBe(false);
    expect(s.me).toBeNull();
    expect(s.loaded).toBe(true);
  });

  it('survives a null or undefined body', () => {
    for (const body of [null, undefined]) {
      expect(() => permStateFromAuthMe(body)).not.toThrow();
      expect(permStateFromAuthMe(body).hasWildcard).toBe(false);
    }
  });

  it('coerces a truthy non-boolean hasWildcard rather than passing it through', () => {
    // hasWildcard is compared by identity in places; a string would break that
    // while still looking correct in a debugger.
    expect(permStateFromAuthMe({ hasWildcard: 'yes' }).hasWildcard).toBe(true);
    expect(permStateFromAuthMe({ hasWildcard: 0 }).hasWildcard).toBe(false);
  });

  it('normalises a missing or null me to null', () => {
    // "No mapping" is ordinary — a fresh deployment, or an admin outside the
    // crawled tenant. Consumers check `me?.photo`, so undefined vs null must
    // not be two different states to handle.
    expect(permStateFromAuthMe({ me: null }).me).toBeNull();
    expect(permStateFromAuthMe({ permissions: [] }).me).toBeNull();
  });
});

describe('contextOwner', () => {
  it('passes the owner\'s contexts through', () => {
    const contextOwner = { contexts: [{ id: 'c1', displayName: 'Finance', role: 'Responsible' }] };
    expect(permStateFromAuthMe({ contextOwner }).contextOwner).toEqual(contextOwner);
  });

  it('is null when absent (an ordinary user, or an older API)', () => {
    expect(permStateFromAuthMe({ permissions: ['data.read'] }).contextOwner).toBeNull();
  });

  it('is null in the degraded state — a failed auth-me never lands anyone on an owner page', () => {
    expect(degradedPermState().contextOwner).toBeNull();
  });
});

describe('isContextOwnerSession', () => {
  const owner = { contexts: [{ id: 'c1' }] };
  const base = { permissionsLoaded: true, hasWildcard: false, permissions: new Set(), contextOwner: owner };

  it('is true for a loaded, permissionless owner', () => {
    expect(isContextOwnerSession(base)).toBe(true);
  });

  it('is false before auth-me has answered', () => {
    expect(isContextOwnerSession({ ...base, permissionsLoaded: false })).toBe(false);
  });

  it('is false with the wildcard (open mode or an admin)', () => {
    expect(isContextOwnerSession({ ...base, hasWildcard: true })).toBe(false);
  });

  it('is false with a single real permission', () => {
    expect(isContextOwnerSession({ ...base, permissions: new Set(['data.read']) })).toBe(false);
  });

  it('is false with no contexts, or no owner block', () => {
    expect(isContextOwnerSession({ ...base, contextOwner: { contexts: [] } })).toBe(false);
    expect(isContextOwnerSession({ ...base, contextOwner: null })).toBe(false);
    expect(isContextOwnerSession()).toBe(false);
  });

  it('treats a missing permission set as none', () => {
    expect(isContextOwnerSession({ ...base, permissions: null })).toBe(true);
  });
});
