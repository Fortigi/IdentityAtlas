import { describe, it, expect } from 'vitest';
import { classifyPermission, HIGH_RISK, MEDIUM_RISK, LOW_RISK } from './riskyConsentRiskMap.js';

describe('classifyPermission', () => {
  it('classifies the well-known dangerous permissions as High', () => {
    expect(classifyPermission('Group.ReadWrite.All')).toBe('High');
    expect(classifyPermission('RoleManagement.ReadWrite.Directory')).toBe('High');
    expect(classifyPermission('Mail.Send')).toBe('High');
    expect(classifyPermission('full_access_as_user')).toBe('High');
  });

  it('classifies broad-read / scoped-write as Medium', () => {
    expect(classifyPermission('Directory.Read.All')).toBe('Medium');
    expect(classifyPermission('Mail.Read')).toBe('Medium');
    expect(classifyPermission('Calendars.ReadWrite')).toBe('Medium');
  });

  it('classifies sign-in basics / self scopes as Low', () => {
    expect(classifyPermission('openid')).toBe('Low');
    expect(classifyPermission('User.Read')).toBe('Low');
    expect(classifyPermission('offline_access')).toBe('Low');
  });

  it('falls back to suffix patterns for unlisted permissions', () => {
    expect(classifyPermission('Widget.ReadWrite.All')).toBe('High');   // *.ReadWrite.All
    expect(classifyPermission('Widget.FullControl.All')).toBe('High'); // *.FullControl.All
    expect(classifyPermission('Widget.Read.All')).toBe('Medium');      // *.Read.All
    expect(classifyPermission('Widget.ReadWrite')).toBe('Medium');     // *.ReadWrite
  });

  it('returns the unknownTier (default Low) for truly unknown permissions', () => {
    expect(classifyPermission('Some.Weird.Scope')).toBe('Low');
    expect(classifyPermission('Some.Weird.Scope', { unknownTier: 'Medium' })).toBe('Medium');
  });

  it('handles null / empty / non-string input via unknownTier', () => {
    expect(classifyPermission(null)).toBe('Low');
    expect(classifyPermission('')).toBe('Low');
    expect(classifyPermission(42)).toBe('Low');
    expect(classifyPermission(null, { unknownTier: 'High' })).toBe('High');
  });

  it('keeps the curated tiers disjoint (no permission in two sets)', () => {
    for (const p of HIGH_RISK) expect(MEDIUM_RISK.has(p) || LOW_RISK.has(p)).toBe(false);
    for (const p of MEDIUM_RISK) expect(LOW_RISK.has(p)).toBe(false);
  });
});
