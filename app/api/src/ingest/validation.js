/**
 * Validation — JSON Schema validation for ingest payloads.
 *
 * Uses lightweight inline validation (no ajv dependency) to keep the package small.
 * Each entity type has a schema definition with required fields, types, and enums.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRINCIPAL_TYPES = ['User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox'];
const ASSIGNMENT_TYPES = ['Direct', 'Indirect', 'Eligible', 'Owner', 'Governed'];
const RELATIONSHIP_TYPES = ['Contains', 'GrantsAccessTo'];

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
      principalType: { type: 'string', maxLength: 50 },
      assignmentType: { type: 'string', enum: ASSIGNMENT_TYPES },
      complianceState: { type: 'string', maxLength: 50 },
      policyId: { type: 'string', maxLength: 255 },
      state: { type: 'string', maxLength: 50 },
      assignmentStatus: { type: 'string', maxLength: 50 },
      expirationDateTime: { type: 'string' },
      extendedAttributes: { type: 'json' },
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
    required: ['displayName'],
    idField: 'id',
    fields: {
      id: { type: 'uuid' },
      displayName: { type: 'string', maxLength: 500 },
      contextType: { type: 'string', maxLength: 50 },
      parentContextId: { type: 'uuid' },
      managerId: { type: 'uuid' },
      managerIdentityId: { type: 'uuid' },
      department: { type: 'string', maxLength: 255 },
      division: { type: 'string', maxLength: 255 },
      costCenter: { type: 'string', maxLength: 255 },
      officeLocation: { type: 'string', maxLength: 255 },
      memberCount: { type: 'number' },
      totalMemberCount: { type: 'number' },
      sourceType: { type: 'string', maxLength: 50 },
      extendedAttributes: { type: 'json' },
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
};

// Table name mapping. v5 keeps the v4 camelCase table names (double-quoted in postgres).
export const ENTITY_TABLE_MAP = {
  'systems': 'Systems',
  'principals': 'Principals',
  'resources': 'Resources',
  'resource-assignments': 'ResourceAssignments',
  'resource-relationships': 'ResourceRelationships',
  'identities': 'Identities',
  'identity-members': 'IdentityMembers',
  'contexts': 'Contexts',
  'governance/catalogs': 'GovernanceCatalogs',
  'governance/policies': 'AssignmentPolicies',
  'governance/requests': 'AssignmentRequests',
  'governance/certifications': 'CertificationDecisions',
};

// Key columns per entity type
export const ENTITY_KEY_MAP = {
  'systems': ['systemType', 'tenantId'],
  'principals': ['id'],
  'resources': ['id'],
  'resource-assignments': ['resourceId', 'principalId', 'assignmentType'],
  'resource-relationships': ['parentResourceId', 'childResourceId', 'relationshipType'],
  'identities': ['id'],
  'identity-members': ['identityId', 'principalId'],
  'contexts': ['id'],
  'governance/catalogs': ['id'],
  'governance/policies': ['id'],
  'governance/requests': ['id'],
  'governance/certifications': ['id'],
};

// Scope filter columns per entity type (used for scoped deletes)
export const ENTITY_SCOPE_MAP = {
  'principals': ['principalType'],
  'resources': ['resourceType'],
  'resource-assignments': ['assignmentType'],
  'resource-relationships': ['relationshipType'],
  'contexts': ['contextType'],
};

/**
 * Validate the ingest request envelope.
 * Returns { valid: true } or { valid: false, errors: [...] }.
 */
export function validateEnvelope(body, entityType) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  // Systems endpoint doesn't require systemId
  if (entityType !== 'systems') {
    if (body.systemId === undefined || body.systemId === null) {
      errors.push('systemId is required');
    }
  }

  if (!Array.isArray(body.records)) {
    errors.push('records must be an array');
  } else if (body.records.length === 0) {
    errors.push('records array cannot be empty');
  } else if (body.records.length > 50000) {
    errors.push('records array cannot exceed 50,000 items');
  }

  if (body.syncMode && !['full', 'delta'].includes(body.syncMode)) {
    errors.push('syncMode must be "full" or "delta"');
  }

  if (body.idGeneration && !['native', 'deterministic'].includes(body.idGeneration)) {
    errors.push('idGeneration must be "native" or "deterministic"');
  }

  if (body.idGeneration === 'deterministic' && !body.idPrefix) {
    errors.push('idPrefix is required when idGeneration is "deterministic"');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate individual records against the entity schema.
 * Returns { valid: true, warnings: [] } or { valid: false, errors: [...] }.
 */
export function validateRecords(records, entityType, idGeneration) {
  const schema = SCHEMAS[entityType];
  if (!schema) {
    return { valid: false, errors: [`Unknown entity type: ${entityType}`] };
  }

  const errors = [];
  const maxErrors = 10; // Stop after 10 errors to avoid flooding

  for (let i = 0; i < records.length && errors.length < maxErrors; i++) {
    const rec = records[i];

    // Check required fields
    for (const field of schema.required) {
      if (rec[field] === undefined || rec[field] === null || rec[field] === '') {
        errors.push(`Record ${i}: missing required field '${field}'`);
      }
    }

    // Check requiredOneOf — at least one of the listed fields must be present.
    // Used by resource-assignments and resource-relationships to accept either
    // the UUID field (resourceId) or the external-ID alias (resourceExternalId).
    if (schema.requiredOneOf) {
      for (const group of schema.requiredOneOf) {
        const hasAny = group.fields.some(f => rec[f] !== undefined && rec[f] !== null && rec[f] !== '');
        if (!hasAny) {
          errors.push(`Record ${i}: one of [${group.fields.join(', ')}] is required`);
        }
      }
    }

    // Check ID field (must be UUID unless using deterministic generation)
    if (schema.idField && idGeneration !== 'deterministic') {
      const idVal = rec[schema.idField];
      if (idVal !== undefined && idVal !== null && !UUID_RE.test(String(idVal))) {
        errors.push(`Record ${i}: '${schema.idField}' must be a valid UUID (got '${String(idVal).slice(0, 50)}')`);
      }
    }

    // Check field types and constraints
    for (const [field, def] of Object.entries(schema.fields)) {
      const val = rec[field];
      if (val === undefined || val === null) continue;

      if (def.type === 'string' && typeof val !== 'string') {
        errors.push(`Record ${i}: '${field}' must be a string`);
      }
      if (def.type === 'uuid' && !UUID_RE.test(String(val))) {
        // Only error if this isn't the ID field with deterministic generation
        if (field !== schema.idField || idGeneration !== 'deterministic') {
          errors.push(`Record ${i}: '${field}' must be a valid UUID`);
        }
      }
      if (def.type === 'number' && typeof val !== 'number') {
        errors.push(`Record ${i}: '${field}' must be a number`);
      }
      if (def.maxLength && typeof val === 'string' && val.length > def.maxLength) {
        errors.push(`Record ${i}: '${field}' exceeds max length of ${def.maxLength}`);
      }
      if (def.enum && !def.enum.includes(val)) {
        errors.push(`Record ${i}: '${field}' must be one of: ${def.enum.join(', ')}`);
      }
    }
  }

  if (errors.length >= maxErrors) {
    errors.push(`... and more errors (stopped after ${maxErrors})`);
  }

  return { valid: errors.length === 0, errors };
}
