// The REAL model definitions, read from the code that enforces them.
//
// Nothing in here is a list of types: every value comes from a constant the
// application already uses (the ingest validation, the ownership list, the
// visibility and effective-access rules). That is the point — the ontology is
// checked against the implementation, not against a third copy of it.

import {
  SCHEMAS, ENTITY_TABLE_MAP,
} from '../ingest/validation.js';
import { OWNERSHIP_RESOURCE_TYPES, OWNERSHIP_RELATIONSHIP_TYPES } from '../lib/ownershipTypes.js';
import { HIDDEN_BY_DEFAULT_RESOURCE_TYPES } from '../lib/resourceVisibility.js';
import { GROUP_RESOURCE_TYPES } from '../effectiveAccess/engine.js';
import { NON_HUMAN_PRINCIPAL_TYPES } from '../accountlinking/orphanQuery.js';

/**
 * Snapshot of every code-side registry the ontology must agree with.
 *   ingest            — the ingest schema of each entity (fields, types, enums),
 *                       keyed by ingest entity, with the table it writes
 *   resourceTypeLists — resourceType values the application branches on
 *   principalTypeLists— principalType values the application branches on
 *   ownership         — the ownership resource types and the relationship
 *                       types that point at them
 */
export function loadRegistry() {
  const ingest = {};
  for (const [entity, schema] of Object.entries(SCHEMAS)) {
    ingest[entity] = { table: ENTITY_TABLE_MAP[entity], fields: schema.fields };
  }
  return {
    ingest,
    resourceTypeLists: {
      'lib/ownershipTypes.js OWNERSHIP_RESOURCE_TYPES': OWNERSHIP_RESOURCE_TYPES,
      'lib/resourceVisibility.js HIDDEN_BY_DEFAULT_RESOURCE_TYPES': HIDDEN_BY_DEFAULT_RESOURCE_TYPES,
      'effectiveAccess/engine.js GROUP_RESOURCE_TYPES': GROUP_RESOURCE_TYPES,
    },
    principalTypeLists: {
      'accountlinking/orphanQuery.js NON_HUMAN_PRINCIPAL_TYPES': NON_HUMAN_PRINCIPAL_TYPES,
    },
    ownership: {
      resourceTypes: OWNERSHIP_RESOURCE_TYPES,
      relationshipTypes: OWNERSHIP_RELATIONSHIP_TYPES,
    },
  };
}
