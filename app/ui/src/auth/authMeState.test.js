// Unit tests for the /api/auth-me → permission-state mapping.
//
// This decides what the whole UI believes the signed-in user may do, so the
// cases below are the ones where a plausible wrong implementation would be
// dangerous rather than merely wrong: a degraded response that reads as admin,
// or a missing field that defaults the wrong way.

import { describe, it, expect } from 'vitest';
import { degradedPermState, permStateFromAuthMe } from './authMeState';

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
