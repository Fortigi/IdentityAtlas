/**
 * Validation — JSON Schema validation for ingest payloads.
 *
 * Uses lightweight inline validation (no ajv dependency) to keep the package small.
 * Each entity type has a schema definition with required fields, types, and enums.
 */

import {
  validateSystemId,
  validateRecordsArray,
  validateDeletedIdsArray,
  validateEnvelopeOptions,
  validateRecord,
} from './validation.helpers.js';

const PRINCIPAL_TYPES = ['User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox'];
// Hard rule (assignment-model redesign): an assignment is only ever one of the
// three universal "how" values. Everything that used to be its own type is now
// modelled differently — ownership is a Direct membership on a GroupOwnership
// resource, governance is the `governed` flag, and the old source-attribute
// types (OAuth2Grant / AppRole / AppRoleViaGroup / DirectoryRole /
// DirectoryRoleEligible) collapse to Direct/Indirect/Eligible + resourceType.
// Ingest REJECTS any other value; assignmentTypes.guard.test.js statically
// scans the crawlers so a retired type can't be reintroduced at the source.
const ASSIGNMENT_TYPES = ['Direct', 'Indirect', 'Eligible'];
const RELATIONSHIP_TYPES = ['Contains', 'GrantsAccessTo', 'DelegatesScope', 'HasAppRole', 'HasOwnership', 'HasAppOwnership', 'HasApplicationPermission'];
// Principal→principal links (see migrations/057_principal_relationships.sql).
// A closed allow-list like assignmentType: ownership of an AI agent and
// sponsorship of a guest are the two responsibility links between two Principals.
// Add a value here (and to the CHECK in migration 057) to introduce a new kind —
// ingest REJECTS anything else.
const PRINCIPAL_RELATIONSHIP_TYPES = ['Owner', 'Sponsor'];

// Schema definitions per entity type
const SCHEMAS = {
  systems: {
    required: ['displayName', 'systemType'],
    fields: {
      displayName: { type: 'string', maxLength: 255 },
      systemType: { type: 'string', maxLength: 50 },
      description: { type: 'string' },
      tenantId: { type: 'string', maxLength: 255 },
      enabled: { type: 'boolean' },
      syncEnabled: { type: 'boolean' },
    },
  },
  principals: {
    required: ['displayName'],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      displayName: { type: 'string', maxLength: 500 },
      email: { type: 'string', maxLength: 500 },
      accountEnabled: { type: 'boolean' },
      principalType: { type: 'string', enum: PRINCIPAL_TYPES },
      externalId: { type: 'string', maxLength: 500 },
      givenName: { type: 'string', maxLength: 255 },
      surname: { type: 'string', maxLength: 255 },
      department: { type: 'string', maxLength: 255 },
      jobTitle: { type: 'string', maxLength: 255 },
      companyName: { type: 'string', maxLength: 255 },
      employeeId: { type: 'string', maxLength: 255 },
      managerId: { type: 'uuid' },
      contextId: { type: 'uuid' },
      createdDateTime: { type: 'string' },
      extendedAttributes: { type: 'json' },
    },
  },
  resources: {
    required: ['displayName'],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      displayName: { type: 'string', maxLength: 500 },
      description: { type: 'string' },
      resourceType: { type: 'string', maxLength: 255 },
      createdDateTime: { type: 'string' },
      modifiedDateTime: { type: 'string' },
      mail: { type: 'string', maxLength: 500 },
      visibility: { type: 'string', maxLength: 50 },
      enabled: { type: 'boolean' },
      externalId: { type: 'string', maxLength: 500 },
      contextId: { type: 'uuid' },
      catalogId: { type: 'uuid' },
      isHidden: { type: 'boolean' },
      governanceResource: { type: 'boolean' },
      extendedAttributes: { type: 'json' },
    },
  },
  'resource-assignments': {
    required: ['assignmentType'],
    // resourceId + principalId are required, but can also be supplied as
    // resourceExternalId + principalExternalId when using deterministic IDs.
    // The normalization layer converts them before they hit the database.
    requiredOneOf: [
      { fields: ['resourceId', 'resourceExternalId'] },
      { fields: ['principalId', 'principalExternalId'] },
    ],
    fields: {
      resourceId: { type: 'uuid' },
      principalId: { type: 'uuid' },
      resourceExternalId: { type: 'string', maxLength: 500 },
      principalExternalId: { type: 'string', maxLength: 500 },
      identityId: { type: 'uuid' },
      identityExternalId: { type: 'string', maxLength: 500 },
      principalType: { type: 'string', maxLength: 50 },
      assignmentType: { type: 'string', enum: ASSIGNMENT_TYPES },
      resourceType: { type: 'string', maxLength: 100 },
      governed: { type: 'boolean' },
      complianceState: { type: 'string', maxLength: 50 },
      policyId: { type: 'string', maxLength: 255 },
      state: { type: 'string', maxLength: 50 },
      assignmentStatus: { type: 'string', maxLength: 50 },
      expirationDateTime: { type: 'string' },
      extendedAttributes: { type: 'json' },
    },
  },
  'resource-assignments-identity': {
    required: ['assignmentType'],
    requiredOneOf: [
      { fields: ['resourceId', 'resourceExternalId'] },
      { fields: ['identityId', 'identityExternalId'] },
    ],
    fields: {
      resourceId:          { type: 'uuid' },
      resourceExternalId:  { type: 'string', maxLength: 500 },
      identityId:          { type: 'uuid' },
      identityExternalId:  { type: 'string', maxLength: 500 },
      assignmentType:      { type: 'string', enum: ASSIGNMENT_TYPES },
      resourceType:        { type: 'string', maxLength: 100 },
      governed:            { type: 'boolean' },
      principalType:       { type: 'string', maxLength: 50 },
      complianceState:     { type: 'string', maxLength: 50 },
      policyId:            { type: 'string', maxLength: 255 },
      state:               { type: 'string', maxLength: 50 },
      assignmentStatus:    { type: 'string', maxLength: 50 },
      expirationDateTime:  { type: 'string' },
      extendedAttributes:  { type: 'json' },
    },
  },
  'resource-relationships': {
    required: ['relationshipType'],
    requiredOneOf: [
      { fields: ['parentResourceId', 'parentExternalId'] },
      { fields: ['childResourceId', 'childExternalId'] },
    ],
    fields: {
      parentResourceId: { type: 'uuid' },
      childResourceId: { type: 'uuid' },
      parentExternalId: { type: 'string', maxLength: 500 },
      childExternalId: { type: 'string', maxLength: 500 },
      relationshipType: { type: 'string', enum: RELATIONSHIP_TYPES },
      roleName: { type: 'string', maxLength: 255 },
      roleOriginSystem: { type: 'string', maxLength: 255 },
      extendedAttributes: { type: 'json' },
    },
  },
  'principal-relationships': {
    required: ['relationshipType'],
    // principalId / relatedPrincipalId are required, but a deterministic-id
    // crawler can supply them as *ExternalId aliases instead (resolved in
    // normalization). principalId = the subject that HAS the owner/sponsor
    // (the AI agent / the guest); relatedPrincipalId = the owner / sponsor.
    requiredOneOf: [
      { fields: ['principalId', 'principalExternalId'] },
      { fields: ['relatedPrincipalId', 'relatedPrincipalExternalId'] },
    ],
    fields: {
      principalId: { type: 'uuid' },
      relatedPrincipalId: { type: 'uuid' },
      principalExternalId: { type: 'string', maxLength: 500 },
      relatedPrincipalExternalId: { type: 'string', maxLength: 500 },
      relationshipType: { type: 'string', enum: PRINCIPAL_RELATIONSHIP_TYPES },
      externalId: { type: 'string', maxLength: 500 },
      extendedAttributes: { type: 'json' },
    },
  },
  identities: {
    required: ['displayName'],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      displayName: { type: 'string', maxLength: 500 },
      email: { type: 'string', maxLength: 500 },
      department: { type: 'string', maxLength: 255 },
      jobTitle: { type: 'string', maxLength: 255 },
      companyName: { type: 'string', maxLength: 255 },
      employeeId: { type: 'string', maxLength: 255 },
      givenName: { type: 'string', maxLength: 255 },
      surname: { type: 'string', maxLength: 255 },
      primaryPrincipalId: { type: 'uuid' },
      contextId: { type: 'uuid' },
      extendedAttributes: { type: 'json' },
    },
  },
  'identity-members': {
    required: [],
    requiredOneOf: [
      { fields: ['identityId', 'identityExternalId'] },
      { fields: ['principalId', 'userExternalId', 'principalExternalId'] },
    ],
    fields: {
      identityId: { type: 'uuid' },
      principalId: { type: 'uuid' },
      identityExternalId: { type: 'string', maxLength: 500 },
      userExternalId: { type: 'string', maxLength: 500 },
      principalExternalId: { type: 'string', maxLength: 500 },
      displayName: { type: 'string', maxLength: 500 },
      accountType: { type: 'string', maxLength: 50 },
      isPrimary: { type: 'boolean' },
      accountEnabled: { type: 'boolean' },
      extendedAttributes: { type: 'json' },
    },
  },
  contexts: {
    required: ['displayName', 'variant', 'targetType', 'contextType'],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      variant: { type: 'string', enum: ['synced', 'generated', 'manual'] },
      targetType: { type: 'string', enum: ['Identity', 'Resource', 'Principal', 'System'] },
      contextType: { type: 'string', maxLength: 50 },
      displayName: { type: 'string', maxLength: 500 },
      description: { type: 'string' },
      parentContextId: { type: 'uuid' },
      parentExternalId: { type: 'string', maxLength: 500 },
      scopeSystemId: { type: 'number' },
      sourceAlgorithmId: { type: 'uuid' },
      sourceRunId: { type: 'uuid' },
      createdByUser: { type: 'string', maxLength: 255 },
      ownerUserId: { type: 'string', maxLength: 255 },
      externalId: { type: 'string', maxLength: 500 },
      directMemberCount: { type: 'number' },
      totalMemberCount: { type: 'number' },
      extendedAttributes: { type: 'json' },
    },
  },
  'context-members': {
    required: ['memberType'],
    requiredOneOf: [
      { fields: ['contextId', 'contextExternalId'] },
      { fields: ['memberId', 'memberExternalId'] },
    ],
    fields: {
      contextId: { type: 'uuid' },
      contextExternalId: { type: 'string', maxLength: 500 },
      memberType: { type: 'string', enum: ['Identity', 'Resource', 'Principal', 'System'] },
      memberId: { type: 'uuid' },
      memberExternalId: { type: 'string', maxLength: 500 },
      addedBy: { type: 'string', enum: ['sync', 'algorithm', 'analyst'] },
    },
  },
  'governance/catalogs': {
    required: ['displayName'],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      displayName: { type: 'string', maxLength: 500 },
      description: { type: 'string' },
      catalogType: { type: 'string', maxLength: 50 },
      externalId: { type: 'string', maxLength: 500 },
      isExternallyVisible: { type: 'boolean' },
      enabled: { type: 'boolean' },
      createdDateTime: { type: 'string' },
      modifiedDateTime: { type: 'string' },
      extendedAttributes: { type: 'json' },
    },
  },
  'governance/policies': {
    required: ['displayName'],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      resourceId: { type: 'uuid' },
      displayName: { type: 'string', maxLength: 500 },
      description: { type: 'string' },
      allowedTargetScope: { type: 'string', maxLength: 255 },
      policyConditions: { type: 'json' },
      reviewSettings: { type: 'json' },
      extendedAttributes: { type: 'json' },
    },
  },
  'governance/requests': {
    required: [],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      resourceId: { type: 'uuid' },
      requestorId: { type: 'uuid' },
      requestType: { type: 'string', maxLength: 50 },
      requestState: { type: 'string', maxLength: 50 },
      requestStatus: { type: 'string', maxLength: 50 },
      justification: { type: 'string' },
      createdDateTime: { type: 'string' },
      completedDateTime: { type: 'string' },
      extendedAttributes: { type: 'json' },
    },
  },
  'governance/certifications': {
    required: [],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      resourceId: { type: 'uuid' },
      resourceExternalId: { type: 'string', maxLength: 500 },
      principalId: { type: 'uuid' },
      principalDisplayName: { type: 'string', maxLength: 500 },
      decision: { type: 'string', maxLength: 100 },
      justification: { type: 'string' },
      recommendation: { type: 'string', maxLength: 50 },
      reviewedBy: { type: 'uuid' },
      reviewedByDisplayName: { type: 'string', maxLength: 500 },
      reviewedDateTime: { type: 'string' },
      reviewDefinitionId: { type: 'uuid' },
      reviewInstanceId: { type: 'uuid' },
      reviewInstanceStatus: { type: 'string', maxLength: 50 },
      reviewInstanceStartDateTime: { type: 'string' },
      reviewInstanceEndDateTime: { type: 'string' },
      extendedAttributes: { type: 'json' },
    },
  },
  // PrincipalActivity — latest sign-in timestamps per principal (aggregate,
  // resourceId=AGG_RESOURCE_ID) or per (principal, app) pair (resourceId=app
  // Resources row). No history; see migrations/017_principal_activity.sql.
  'principal-activity': {
    required: ['principalId', 'activityType'],
    fields: {
      principalId: { type: 'uuid' },
      resourceId: { type: 'uuid' },
      activityType: { type: 'string', maxLength: 100 },
      lastSignInDateTime: { type: 'string' },
      lastNonInteractiveSignInDateTime: { type: 'string' },
      lastSuccessfulSignInDateTime: { type: 'string' },
      lastFailedSignInDateTime: { type: 'string' },
      signInCount: { type: 'number' },
      extendedAttributes: { type: 'json' },
    },
  },
};

// Sentinel UUID used as resourceId on aggregate PrincipalActivity rows.
// Mirrors the DEFAULT on the migration.
export const AGG_RESOURCE_ID = '00000000-0000-0000-0000-000000000000';

// Table name mapping. v5 keeps the v4 camelCase table names (double-quoted in postgres).
export const ENTITY_TABLE_MAP = {
  'systems': 'Systems',
  'principals': 'Principals',
  'resources': 'Resources',
  'resource-assignments': 'ResourceAssignments',
  'resource-assignments-identity': 'ResourceAssignments',
  'resource-relationships': 'ResourceRelationships',
  'principal-relationships': 'PrincipalRelationships',
  'identities': 'Identities',
  'identity-members': 'IdentityMembers',
  'contexts': 'Contexts',
  'context-members': 'ContextMembers',
  'governance/catalogs': 'GovernanceCatalogs',
  'governance/policies': 'AssignmentPolicies',
  'governance/requests': 'AssignmentRequests',
  'governance/certifications': 'CertificationDecisions',
  'principal-activity': 'PrincipalActivity',
};

// Key columns per entity type
export const ENTITY_KEY_MAP = {
  'systems': ['systemType', 'tenantId'],
  'principals': ['id'],
  'resources': ['id'],
  'resource-assignments': ['resourceId', 'principalId', 'assignmentType', 'governed'],
  'resource-assignments-identity': ['resourceId', 'identityId', 'assignmentType', 'governed'],
  'resource-relationships': ['parentResourceId', 'childResourceId', 'relationshipType'],
  'principal-relationships': ['principalId', 'relatedPrincipalId', 'relationshipType'],
  'identities': ['id'],
  'identity-members': ['identityId', 'principalId'],
  'contexts': ['id'],
  'context-members': ['contextId', 'memberId'],
  'governance/catalogs': ['id'],
  'governance/policies': ['id'],
  'governance/requests': ['id'],
  'governance/certifications': ['id'],
  // PrincipalActivity is keyed on (principalId, resourceId, activityType).
  // Aggregate rows use resourceId = AGG_RESOURCE_ID; the ingest engine
  // upserts via ON CONFLICT across the composite key, so the sentinel and
  // real-resource rows coexist cleanly under one unique constraint.
  'principal-activity': ['principalId', 'resourceId', 'activityType'],
};

// Scope filter columns per entity type (used for scoped deletes).
// `resourceType` is accepted on assignment scopes to let the full-sync reconcile
// delete partition on the resource axis (assignment-model redesign, phase 1).
// It is inert until crawlers actually send it: ingest.js only copies scope keys
// that are present in the request body, so today's crawlers (which send only
// assignmentType) get exactly the same delete as before.
export const ENTITY_SCOPE_MAP = {
  'principals': ['principalType'],
  'resources': ['resourceType'],
  'resource-assignments': ['assignmentType', 'resourceType', 'governed'],
  'resource-assignments-identity': ['assignmentType', 'resourceType', 'governed'],
  'resource-relationships': ['relationshipType'],
  // Scope full-sync reconcile by relationshipType so an Owner-only sync never
  // wipes Sponsor links (mirrors resource-relationships' HasAppOwnership split).
  'principal-relationships': ['relationshipType'],
  'contexts': ['variant', 'contextType', 'scopeSystemId', 'sourceAlgorithmId'],
  'context-members': ['contextId'],
};

/**
 * Validate the ingest request envelope.
 * Returns { valid: true } or { valid: false, errors: [...] }.
 */
export function validateEnvelope(body, entityType) {
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  const errors = [
    ...validateSystemId(body, entityType),
    ...validateRecordsArray(body),
    ...validateDeletedIdsArray(body),
    ...validateEnvelopeOptions(body),
  ];

  return { valid: errors.length === 0, errors };
}

/**
 * Validate individual records against the entity schema.
 * Returns { valid: true, warnings: [] } or { valid: false, errors: [...] }.
 */
export function validateRecords(records, entityType, idGeneration, syncMode = 'full') {
  const schema = SCHEMAS[entityType];
  if (!schema) {
    return { valid: false, errors: [`Unknown entity type: ${entityType}`] };
  }

  const errors = [];
  const maxErrors = 10; // Stop after 10 errors to avoid flooding

  for (let i = 0; i < records.length && errors.length < maxErrors; i++) {
    errors.push(...validateRecord(records[i], i, schema, entityType, idGeneration, syncMode));
  }

  if (errors.length >= maxErrors) {
    errors.push(`... and more errors (stopped after ${maxErrors})`);
  }

  return { valid: errors.length === 0, errors };
}
