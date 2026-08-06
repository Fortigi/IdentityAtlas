import { describe, it, expect } from 'vitest';
import {
  getApRoleBadge,
  AP_ROLE_BADGE_DIRECT,
  AP_ROLE_BADGE_ELIGIBLE,
  ASSIGNMENT_TYPE_STYLES,
  COMPLIANCE_STYLES,
} from './accessPackageStyles.js';

describe('getApRoleBadge', () => {
  it('maps an eligible role scope to the Eligible badge', () => {
    expect(getApRoleBadge('Eligible Member')).toBe(AP_ROLE_BADGE_ELIGIBLE);
    expect(getApRoleBadge('ELIGIBLE')).toBe(AP_ROLE_BADGE_ELIGIBLE);
    expect(getApRoleBadge('Some Group (eligible)').letter).toBe('E');
  });

  it('maps every other role scope — Member included — to the Direct badge', () => {
    expect(getApRoleBadge('Member')).toBe(AP_ROLE_BADGE_DIRECT);
    expect(getApRoleBadge('Some Group (Member)').letter).toBe('D');
  });

  it('maps an Owner role scope to Direct — ownership is its own resource now', () => {
    // Graph stamps the access package's resource-role displayName verbatim, so
    // a package granting a group's Owner role arrives as roleName='Owner'. It
    // is still access the subject holds, so it badges as Direct — never hidden.
    expect(getApRoleBadge('Owner')).toBe(AP_ROLE_BADGE_DIRECT);
    expect(getApRoleBadge('PCM - Piket bevoegdheden (Owner)').letter).toBe('D');
  });

  it('falls back to Direct for a missing role name', () => {
    expect(getApRoleBadge(undefined).letter).toBe('D');
    expect(getApRoleBadge(null).letter).toBe('D');
    expect(getApRoleBadge('').letter).toBe('D');
  });

  it('exposes badge colours for both letters', () => {
    for (const badge of [AP_ROLE_BADGE_DIRECT, AP_ROLE_BADGE_ELIGIBLE]) {
      expect(badge.bg).toMatch(/^#[0-9a-f]{3,6}$/i);
      expect(badge.text).toMatch(/^#[0-9a-f]{3,6}$/i);
    }
    expect(AP_ROLE_BADGE_DIRECT.letter).not.toBe(AP_ROLE_BADGE_ELIGIBLE.letter);
  });
});

describe('badge style maps', () => {
  it('keeps the assignment-type and compliance class maps populated', () => {
    expect(Object.keys(ASSIGNMENT_TYPE_STYLES)).toContain('Auto-assigned');
    expect(Object.keys(COMPLIANCE_STYLES)).toContain('Compliant');
  });
});
