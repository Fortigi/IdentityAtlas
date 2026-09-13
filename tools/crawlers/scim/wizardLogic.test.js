/**
 * Unit tests for the SCIM wizard's extracted pure logic — the opt-in attribute
 * picker, the "at least one object type" gate, and the saved-config builder.
 * These are the branches a render smoke test can't reach (no handlers fire) and
 * where a silent regression would either drop a selected attribute on save or let
 * a sync-nothing config through. Runs under the UI's vitest.
 */
import { describe, it, expect } from 'vitest';
import { toggleAttribute, toggleAllAttributes, canSubmitObjects, buildScimConfig } from './ConfigWizard.jsx';

describe('toggleAttribute', () => {
  it('adds an attribute that is not selected yet', () => {
    expect(toggleAttribute([], 'department')).toEqual(['department']);
    expect(toggleAttribute(['title'], 'department')).toEqual(['title', 'department']);
  });

  it('removes an attribute that is already selected', () => {
    expect(toggleAttribute(['title', 'department'], 'title')).toEqual(['department']);
  });

  it('returns a new array rather than mutating the input', () => {
    const original = ['title'];
    const next = toggleAttribute(original, 'department');
    expect(original).toEqual(['title']);
    expect(next).not.toBe(original);
  });

  it('treats a missing selection list as empty', () => {
    expect(toggleAttribute(undefined, 'department')).toEqual(['department']);
  });
});

describe('toggleAllAttributes', () => {
  it('selects every discovered attribute when some are missing', () => {
    expect(toggleAllAttributes(['a'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('clears them again when all discovered attributes are already selected', () => {
    expect(toggleAllAttributes(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('keeps a previously-saved selection that is no longer discovered', () => {
    // 'legacy' was selected against an older schema; Select all must not silently
    // drop it, and Deselect all must not remove it either.
    expect(toggleAllAttributes(['legacy'], ['a'])).toEqual(['legacy', 'a']);
    expect(toggleAllAttributes(['legacy', 'a'], ['a'])).toEqual(['legacy']);
  });

  it('does nothing when nothing was discovered', () => {
    expect(toggleAllAttributes(['a'], [])).toEqual(['a']);
    expect(toggleAllAttributes([], [])).toEqual([]);
  });

  it('never duplicates an already-selected attribute', () => {
    expect(toggleAllAttributes(['a'], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('canSubmitObjects', () => {
  it('requires at least Users or Groups', () => {
    expect(canSubmitObjects({ users: true, groups: false, groupMembers: false })).toBe(true);
    expect(canSubmitObjects({ users: false, groups: true, groupMembers: false })).toBe(true);
    expect(canSubmitObjects({ users: false, groups: false, groupMembers: true })).toBe(false);
    expect(canSubmitObjects({ users: false, groups: false, groupMembers: false })).toBe(false);
  });

  it('rejects a missing selection object', () => {
    expect(canSubmitObjects(undefined)).toBe(false);
  });
});

describe('buildScimConfig', () => {
  const base = {
    baseUrl: 'https://scim.example.com/scim/v2/',
    authMethod: 'ApiToken',
    systemName: '  SAP CIS  ',
    pageSize: '50',
    selectedObjects: { users: true, groups: true, groupMembers: false },
    userAttributes: ['department'],
    groupAttributes: [],
    userTypeMapping: [{ userType: ' service ', principalType: 'ServicePrincipal' }],
  };

  it('trims the base URL and strips trailing slashes so /Users never doubles up', () => {
    expect(buildScimConfig(base).baseUrl).toBe('https://scim.example.com/scim/v2');
  });

  it('coerces the page size to a number and falls back to 100', () => {
    expect(buildScimConfig(base).pageSize).toBe(50);
    expect(buildScimConfig({ ...base, pageSize: '' }).pageSize).toBe(100);
    expect(buildScimConfig({ ...base, pageSize: 'abc' }).pageSize).toBe(100);
  });

  it('defaults the system name when left blank', () => {
    expect(buildScimConfig(base).systemName).toBe('SAP CIS');
    expect(buildScimConfig({ ...base, systemName: '   ' }).systemName).toBe('SCIM');
  });

  it('writes every object toggle as an explicit boolean', () => {
    expect(buildScimConfig(base).selectedObjects).toEqual({ users: true, groups: true, groupMembers: false });
  });

  it('preserves the opt-in attribute selections per object type', () => {
    const cfg = buildScimConfig(base);
    expect(cfg.selectedAttributes).toEqual({ user: ['department'], group: [] });
  });

  it('keeps an empty attribute selection empty (opt-in, never auto-filled)', () => {
    const cfg = buildScimConfig({ ...base, userAttributes: [], groupAttributes: [] });
    expect(cfg.selectedAttributes).toEqual({ user: [], group: [] });
  });

  it('trims the userType in each mapping row and defaults the principal type', () => {
    const cfg = buildScimConfig({ ...base, userTypeMapping: [{ userType: ' service ' }, { userType: '', principalType: 'User' }] });
    expect(cfg.userTypeMapping).toEqual([
      { userType: 'service', principalType: 'User' },
      { userType: '', principalType: 'User' },
    ]);
  });

  it('omits scope and schedules when they are empty', () => {
    const cfg = buildScimConfig({ ...base, scope: '  ', schedules: [] });
    expect(cfg.scope).toBeUndefined();
    expect(cfg.schedules).toBeUndefined();
  });

  it('includes scope and schedules when set', () => {
    const schedules = [{ enabled: true, syncMode: 'full', frequency: 'daily', hour: 2, minute: 0 }];
    const cfg = buildScimConfig({ ...base, scope: ' scim:read ', schedules });
    expect(cfg.scope).toBe('scim:read');
    expect(cfg.schedules).toEqual(schedules);
  });

  it('never emits a credential field — those come from buildCredentialFields', () => {
    const cfg = buildScimConfig({ ...base, password: 'p', apiToken: 't', clientSecret: 's' });
    for (const key of ['password', 'apiToken', 'clientSecret', 'username', 'clientId']) {
      expect(cfg).not.toHaveProperty(key);
    }
  });
});
