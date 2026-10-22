// The template a known contextType falls under — one place for the mapping the
// migration (092) backfilled with, the ingest derives a missing contextCategory
// from, and the ontology describes (ontology/core.ttl: each type's template
// ancestor). A value not listed here gets no template: it stays readable and
// shows under "Other" until a source, a plugin or an analyst places it.
//
// Plugins do not use this: they declare their template themselves
// (contexts/plugins/*.js contextCategory) and the ontology check holds the two
// in step. The crawler-synced values (OrgUnit, Department, Location …) are why
// this list exists.

import { CONTEXT_CATEGORIES } from '../ingest/validation.js';

export const CONTEXT_TYPE_CATEGORY = Object.freeze({
  ManagerHierarchy: 'OrganizationalUnit',
  OrganisationalUnit: 'OrganizationalUnit',
  Department: 'OrganizationalUnit',
  OrgUnit: 'OrganizationalUnit',
  Team: 'OrganizationalUnit',
  AdministrativeUnit: 'OrganizationalUnit',
  CostCenter: 'OrganizationalUnit',
  LogicalApplication: 'LogicalApplication',
  ContextRecipe: 'LogicalApplication',
  Tag: 'Tag',
  PrincipalType: 'Segment',
  ResourceType: 'Segment',
  ResourcePlane: 'Segment',
  ResourceRole: 'Segment',
  Scope: 'Segment',
  EntraGroupCategory: 'Segment',
  SystemMembership: 'Segment',
  OrphanedAccounts: 'Segment',
  RiskyConsent: 'Segment',
  RiskyAppConsent: 'Segment',
  ResourceCluster: 'Segment',
  Location: 'Segment',
});

/** The template for a contextType, or null when the value is not a known one. */
export function categoryForContextType(contextType) {
  const category = Object.hasOwn(CONTEXT_TYPE_CATEGORY, contextType) ? CONTEXT_TYPE_CATEGORY[contextType] : null;
  return CONTEXT_CATEGORIES.includes(category) ? category : null;
}

// The templates whose contexts have people who answer for them (ContextRoles,
// migration 092): an organizational unit and a logical application. A Segment
// or a Tag carries no roles. Shared by the roles API and the ingest, which
// states a synced owner as the Accountable (ingest/contextOwners.js).
export const ROLE_BEARING_CATEGORIES = new Set(['OrganizationalUnit', 'LogicalApplication']);
