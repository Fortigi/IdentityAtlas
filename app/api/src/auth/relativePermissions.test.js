// The relative-permission policy model (auth/relativePermissions.js).

import { describe, it, expect } from 'vitest';
import {
  relativeSubjects, normalizePolicy, validatePolicy, allows, rolesAllowing, anyContextAllows, anyBusinessRoleAllows,
  anyView, legacyPolicy, BUSINESS_ROLE_SUBJECT,
} from './relativePermissions.js';
import { ROLE_BEARING_CATEGORIES } from '../lib/contextCategories.js';

describe('relativeSubjects', () => {
  it('lists every role-bearing template with the context capabilities, then business roles', () => {
    const subjects = relativeSubjects();
    expect(subjects.map(s => s.subject)).toEqual([...ROLE_BEARING_CATEGORIES, BUSINESS_ROLE_SUBJECT]);
    expect(subjects[0]).toEqual({ subject: 'OrganizationalUnit', kind: 'context', capabilities: ['view', 'subUnits', 'mcp'] });
    expect(subjects.at(-1)).toEqual({ subject: 'BusinessRole', kind: 'businessRole', capabilities: ['view', 'review'] });
  });

  it('hands out copies, so a caller cannot change the grid for everyone', () => {
    relativeSubjects()[0].capabilities.push('admin');
    expect(relativeSubjects()[0].capabilities).toEqual(['view', 'subUnits', 'mcp']);
  });
});

describe('normalizePolicy', () => {
  it('is everything off for nothing', () => {
    const p = normalizePolicy(undefined);
    expect(p.OrganizationalUnit.Accountable).toEqual({ view: false, subUnits: false, mcp: false });
    expect(p.BusinessRole.Responsible).toEqual({ view: false, review: false });
    expect(anyView(p)).toBe(false);
  });

  it('counts only a literal true', () => {
    const p = normalizePolicy({ OrganizationalUnit: { Accountable: { view: 'true', subUnits: 1 } } });
    expect(p.OrganizationalUnit.Accountable.view).toBe(false);
  });

  it('turns subUnits and mcp off where view is off — but keeps review', () => {
    const p = normalizePolicy({
      OrganizationalUnit: { Accountable: { subUnits: true, mcp: true } },
      BusinessRole: { Accountable: { review: true } },
    });
    expect(p.OrganizationalUnit.Accountable).toEqual({ view: false, subUnits: false, mcp: false });
    expect(p.BusinessRole.Accountable).toEqual({ view: false, review: true });
  });

  it('drops unknown subjects, roles and capabilities', () => {
    const p = normalizePolicy({ Tag: { Accountable: { view: true } }, OrganizationalUnit: { Owner: { view: true }, Accountable: { view: true, admin: true } } });
    expect(p.Tag).toBeUndefined();
    expect(p.OrganizationalUnit.Owner).toBeUndefined();
    expect(p.OrganizationalUnit.Accountable).toEqual({ view: true, subUnits: false, mcp: false });
  });
});

describe('validatePolicy', () => {
  it('accepts a partial grid and returns it normalized', () => {
    const { policy, error } = validatePolicy({ LogicalApplication: { Accountable: { view: true, mcp: true } } });
    expect(error).toBeUndefined();
    expect(policy.LogicalApplication.Accountable).toEqual({ view: true, subUnits: false, mcp: true });
    expect(policy.LogicalApplication.Responsible.view).toBe(false);
  });

  it.each([
    [null, 'policy must be an object'],
    ['x', 'policy must be an object'],
    [{ Segment: {} }, 'unknown subject Segment'],
    [{ BusinessRole: [] }, 'BusinessRole must be an object'],
    [{ BusinessRole: { Consulted: {} } }, 'unknown role Consulted for BusinessRole'],
    [{ BusinessRole: { Accountable: [] } }, 'BusinessRole.Accountable must be an object'],
    [{ BusinessRole: { Accountable: { subUnits: true } } }, 'unknown capability subUnits for BusinessRole'],
    [{ BusinessRole: { Accountable: { review: null } } }, 'BusinessRole.Accountable.review must be a boolean'],
  ])('refuses %j', (body, error) => {
    expect(validatePolicy(body)).toEqual({ error });
  });
});

describe('reading a policy', () => {
  const p = normalizePolicy({
    LogicalApplication: { Responsible: { view: true, mcp: true } },
    BusinessRole: { Accountable: { review: true } },
  });

  it('allows answers per subject, role and capability', () => {
    expect(allows(p, 'LogicalApplication', 'Responsible', 'mcp')).toBe(true);
    expect(allows(p, 'LogicalApplication', 'Accountable', 'mcp')).toBe(false);
    expect(allows(p, 'OrganizationalUnit', 'Responsible', 'view')).toBe(false);
    // a context without a template, or no policy at all, is never allowed
    expect(allows(p, null, 'Responsible', 'view')).toBe(false);
    expect(allows(null, 'LogicalApplication', 'Responsible', 'view')).toBe(false);
  });

  it('rolesAllowing names the roles whose row gives a capability', () => {
    expect(rolesAllowing(p, BUSINESS_ROLE_SUBJECT, 'review')).toEqual(['Accountable']);
    expect(rolesAllowing(p, BUSINESS_ROLE_SUBJECT, 'view')).toEqual([]);
    expect(rolesAllowing(p, 'LogicalApplication', 'view')).toEqual(['Responsible']);
  });

  it('anyContextAllows / anyBusinessRoleAllows / anyView look across the rows', () => {
    expect(anyContextAllows(p, 'mcp')).toBe(true);
    expect(anyContextAllows(p, 'subUnits')).toBe(false);
    expect(anyBusinessRoleAllows(p, 'review')).toBe(true);
    expect(anyBusinessRoleAllows(p, 'view')).toBe(false);
    expect(anyView(p)).toBe(true);
    expect(anyView(normalizePolicy({ BusinessRole: { Responsible: { view: true } } }))).toBe(true);
    expect(anyView(normalizePolicy({ BusinessRole: { Responsible: { review: true } } }))).toBe(false);
  });
});

describe('legacyPolicy', () => {
  it('is everything off with no switches', () => {
    expect(anyView(legacyPolicy())).toBe(false);
    expect(anyBusinessRoleAllows(legacyPolicy(), 'review')).toBe(false);
  });

  it('gives Accountable and Responsible the same, on every template', () => {
    const p = legacyPolicy({ access: true, mcp: true });
    for (const subject of ROLE_BEARING_CATEGORIES) {
      expect(p[subject].Accountable).toEqual({ view: true, subUnits: true, mcp: true });
      expect(p[subject].Responsible).toEqual(p[subject].Accountable);
    }
  });

  it('business roles need access for view, not for review', () => {
    expect(legacyPolicy({ businessRoles: true }).BusinessRole.Accountable).toEqual({ view: false, review: false });
    expect(legacyPolicy({ access: true, businessRoles: true }).BusinessRole.Accountable).toEqual({ view: true, review: false });
    expect(legacyPolicy({ ownerReview: true }).BusinessRole.Responsible).toEqual({ view: false, review: true });
  });
});
