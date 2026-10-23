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
import { REGISTERED_PLUGINS } from '../contexts/plugins/registry.js';
import { scanContextTypeUsage } from './contextTypeUsage.js';
import { _crawlerManifests } from '../crawlerManifests.js';

/**
 * Snapshot of every code-side registry the ontology must agree with.
 *   ingest            — the ingest schema of each entity (fields, types, enums),
 *                       keyed by ingest entity, with the table it writes
 *   resourceTypeLists — resourceType values the application branches on
 *   principalTypeLists— principalType values the application branches on
 *   ownership         — the ownership resource types and the relationship
 *                       types that point at them
 *   contexts          — what each context-algorithm plugin emits (name,
 *                       targetType, contextTypes), and the contextType values
 *                       the rest of the code compares against, with where
 *   access            — what holding a resource reaches: the types the
 *                       effective-access engine expands, and the ones that
 *                       never count as access (ownership)
 *   crawlers          — what each crawler manifest declares it writes
 *                       (crawler.json `emits`: fixed types per field, and the
 *                       fields it passes free values through for)
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
    contexts: {
      plugins: REGISTERED_PLUGINS.map(p => ({ name: p.name, targetType: p.targetType, contextTypes: p.contextTypes })),
      branchedOn: scanContextTypeUsage(),
    },
    access: { expands: GROUP_RESOURCE_TYPES, never: OWNERSHIP_RESOURCE_TYPES },
    crawlers: Object.values(_crawlerManifests).map(m => ({ type: m.type, emits: m.emits })),
  };
}
