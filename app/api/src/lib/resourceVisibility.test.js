// Unit tests for the default row-visibility deny-list (#937).
//
// The module is small but decides whether whole rows appear, on two surfaces
// (the matrix resource axis and the Resources list), so the cases below pick
// values that DISCRIMINATE: a type that is hidden vs. a near-miss spelling of
// it, NULL vs. a real type, an include condition on the right field vs. the
// same values on the wrong field or on the exclude side.
import { describe, it, expect } from 'vitest';
import {
  HIDDEN_BY_DEFAULT_RESOURCE_TYPES,
  isHiddenByDefaultResourceType,
  visibleResourceTypesSql,
  scopeTargetsHiddenResourceTypes,
  shouldHideDefaultResourceTypes,
} from './resourceVisibility.js';

describe('HIDDEN_BY_DEFAULT_RESOURCE_TYPES', () => {
  it('hides business roles and nothing else', () => {
    // Pinned as a set, not "contains BusinessRole": adding a type here changes
    // what every matrix renders, so it is a deliberate decision, not a detail.
    expect(HIDDEN_BY_DEFAULT_RESOURCE_TYPES).toEqual(['BusinessRole']);
  });

  it('leaves the ownership types visible — they are unique IST rows, not duplicates', () => {
    // Decision 3 of the #937 spec. A GroupOwnership row is the only place the
    // matrix shows who controls a group; regressing it would silently blank a
    // whole class of rows with no other symptom.
    expect(isHiddenByDefaultResourceType('GroupOwnership')).toBe(false);
    expect(isHiddenByDefaultResourceType('ServicePrincipalOwnership')).toBe(false);
    expect(isHiddenByDefaultResourceType('ApplicationOwnership')).toBe(false);
  });
});

describe('isHiddenByDefaultResourceType', () => {
  it('matches the hidden type exactly, not by prefix, case or substring', () => {
    expect(isHiddenByDefaultResourceType('BusinessRole')).toBe(true);
    // An open vocabulary: a crawler is free to emit any of these, and none of
    // them is the governance type, so all stay visible.
    expect(isHiddenByDefaultResourceType('businessrole')).toBe(false);
    expect(isHiddenByDefaultResourceType('BusinessRoleGrant')).toBe(false);
    expect(isHiddenByDefaultResourceType('SubBusinessRole')).toBe(false);
  });

  it('treats an unknown or absent type as visible', () => {
    expect(isHiddenByDefaultResourceType('Group')).toBe(false);
    expect(isHiddenByDefaultResourceType('SomeFutureCsvType')).toBe(false);
    expect(isHiddenByDefaultResourceType(null)).toBe(false);
    expect(isHiddenByDefaultResourceType(undefined)).toBe(false);
  });
});

describe('visibleResourceTypesSql', () => {
  it('defaults to the bare column, NULL-safe', () => {
    // NULL must pass: `NOT IN` alone evaluates to NULL for a type-less resource,
    // which is falsy in WHERE and would drop every untyped row from the matrix.
    expect(visibleResourceTypesSql()).toBe(
      `("resourceType" IS NULL OR "resourceType" NOT IN ('BusinessRole'))`);
  });

  it('renders whatever expression the caller holds the type in', () => {
    expect(visibleResourceTypesSql('r."resourceType"')).toBe(
      `(r."resourceType" IS NULL OR r."resourceType" NOT IN ('BusinessRole'))`);
    // The as-of timeline reads the type out of a JSONB row snapshot.
    expect(visibleResourceTypesSql(`sr.state->>'resourceType'`)).toBe(
      `(sr.state->>'resourceType' IS NULL OR sr.state->>'resourceType' NOT IN ('BusinessRole'))`);
  });
});

describe('scopeTargetsHiddenResourceTypes', () => {
  const cond = (field, values) => ({ kind: 'attribute', field, values });

  it('is true when an include condition names a hidden type', () => {
    expect(scopeTargetsHiddenResourceTypes({ include: [cond('resourceType', ['BusinessRole'])] })).toBe(true);
    // One hidden type among several still counts — the analyst asked for it.
    expect(scopeTargetsHiddenResourceTypes({ include: [cond('resourceType', ['Group', 'BusinessRole'])] })).toBe(true);
  });

  it('is false for the same values on the wrong field, kind or side', () => {
    expect(scopeTargetsHiddenResourceTypes({ include: [cond('displayName', ['BusinessRole'])] })).toBe(false);
    expect(scopeTargetsHiddenResourceTypes({ include: [cond('resourceType', ['Group'])] })).toBe(false);
    expect(scopeTargetsHiddenResourceTypes({
      include: [{ kind: 'context', field: 'resourceType', values: ['BusinessRole'] }],
    })).toBe(false);
    // Excluding business roles is not asking to see them.
    expect(scopeTargetsHiddenResourceTypes({ include: [], exclude: [cond('resourceType', ['BusinessRole'])] })).toBe(false);
  });

  it('survives missing, malformed and non-string condition data', () => {
    expect(scopeTargetsHiddenResourceTypes(undefined)).toBe(false);
    expect(scopeTargetsHiddenResourceTypes({})).toBe(false);
    expect(scopeTargetsHiddenResourceTypes({ include: 'BusinessRole' })).toBe(false);
    expect(scopeTargetsHiddenResourceTypes({ include: [null, cond('resourceType', null)] })).toBe(false);
  });
});

describe('shouldHideDefaultResourceTypes', () => {
  it('hides by default', () => {
    expect(shouldHideDefaultResourceTypes({ resource: { include: [], exclude: [] } })).toBe(true);
    expect(shouldHideDefaultResourceTypes({})).toBe(true);
    expect(shouldHideDefaultResourceTypes(undefined)).toBe(true);
  });

  it('stops hiding when the matrix definition opts in', () => {
    expect(shouldHideDefaultResourceTypes({ includeBusinessRoles: true })).toBe(false);
    // Strict true only — a filter that never set the flag must not turn it on
    // through a truthy leftover.
    expect(shouldHideDefaultResourceTypes({ includeBusinessRoles: 'true' })).toBe(true);
    expect(shouldHideDefaultResourceTypes({ includeBusinessRoles: false })).toBe(true);
  });

  it('stops hiding when the resource scope explicitly asks for the type', () => {
    expect(shouldHideDefaultResourceTypes({
      resource: { include: [{ kind: 'attribute', field: 'resourceType', values: ['BusinessRole'] }], exclude: [] },
    })).toBe(false);
  });
});
