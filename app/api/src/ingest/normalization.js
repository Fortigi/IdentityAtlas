/**
 * Normalization — Type coercion, deterministic GUID generation, extendedAttributes packing.
 */
import crypto from 'crypto';

/**
 * Generate a deterministic UUID v3-style GUID from a namespace prefix and external ID.
 * Uses MD5 to match the existing PowerShell CSV sync pattern.
 *
 * @param {string} prefix - Namespace prefix (e.g., 'omada-resource')
 * @param {string} externalId - External identifier
 * @returns {string} UUID-formatted GUID
 */
export function deterministicGuid(prefix, externalId) {
  const input = `${prefix}:${externalId}`;
  const hash = crypto.createHash('md5').update(input, 'utf8').digest('hex');
  // Format as UUID: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// External-ID → target-column mappings that resolve 1:1 into a fixed entity
// namespace. Each entry: the caller-supplied field, the normalized column it
// fills, and the entity suffix whose "<sys>-<suffix>" namespace generated that
// entity's deterministic id. Resolved only when the field is present and the
// target isn't already set. parentExternalId and memberExternalId are handled
// separately in resolveExternalRefs (their target/namespace is dynamic).
const SIMPLE_EXTERNAL_REFS = [
  { field: 'childExternalId',     target: 'childResourceId', ns: 'resources' },
  { field: 'identityExternalId',  target: 'identityId',      ns: 'identities' },
  { field: 'userExternalId',      target: 'principalId',     ns: 'principals' },
  { field: 'resourceExternalId',  target: 'resourceId',      ns: 'resources' },
  { field: 'principalExternalId', target: 'principalId',     ns: 'principals' },
  { field: 'relatedPrincipalExternalId', target: 'relatedPrincipalId', ns: 'principals' },
  { field: 'contextExternalId',   target: 'contextId',       ns: 'contexts' },
];

/**
 * Resolve a record's external-ID references to deterministic UUIDs in the same
 * "<sys>-<entity>" namespace the target entity used, so the generated FKs line
 * up with the rows the other endpoints created. Mutates `normalized`.
 *
 * All target column names come from trusted constants (never the record), so the
 * dynamic `normalized[target]` writes can't be remote-property-injected.
 */
function resolveExternalRefs(rec, normalized, coreSet, sysPrefix) {
  // A parentExternalId names the record's parent in the SAME entity family, so it
  // must land on whichever parent FK the target table has: a Context's parent is
  // another Context ("<sys>-contexts" → parentContextId); a resource
  // relationship's parent is another Resource ("<sys>-resources" →
  // parentResourceId). Keying off coreSet stops a context tree's parentExternalId
  // mis-resolving to a Resources id (which left the hierarchy unset, surviving
  // only as raw text in extendedAttributes).
  if (rec.parentExternalId) {
    if (coreSet.has('parentContextId') && !normalized.parentContextId) {
      normalized.parentContextId = deterministicGuid(`${sysPrefix}-contexts`, String(rec.parentExternalId));
    } else if (coreSet.has('parentResourceId') && !normalized.parentResourceId) {
      normalized.parentResourceId = deterministicGuid(`${sysPrefix}-resources`, String(rec.parentExternalId));
    }
  }

  for (const { field, target, ns } of SIMPLE_EXTERNAL_REFS) {
    if (rec[field] && !normalized[target]) {
      normalized[target] = deterministicGuid(`${sysPrefix}-${ns}`, String(rec[field]));
    }
  }

  // A context-member's memberId namespace depends on what kind of entity it is.
  if (rec.memberExternalId && !normalized.memberId) {
    const memberNs = { Identity: 'identities', Principal: 'principals', Resource: 'resources' }[rec.memberType];
    if (memberNs) {
      normalized.memberId = deterministicGuid(`${sysPrefix}-${memberNs}`, String(rec.memberExternalId));
    }
  }
}

/**
 * Normalize a batch of records for a given entity type.
 *
 * - Assigns deterministic GUIDs if idGeneration === 'deterministic'
 * - Coerces types (dates to ISO strings)
 * - Packs non-core fields into extendedAttributes JSON
 *
 * @param {object[]} records - Raw records from the API request
 * @param {string[]} coreColumns - Known columns in the target table
 * @param {object} options
 * @param {string} options.idGeneration - 'native' (default) or 'deterministic'
 * @param {string} options.idPrefix - Namespace for deterministic GUIDs
 * @param {string} options.systemPrefix - System-only prefix (no entity suffix) for
 *   cross-entity reference resolution. When omitted, falls back to idPrefix.split('-')[0],
 *   which is wrong whenever the system prefix itself contains a hyphen.
 * @param {number} options.systemId - System ID to set on each record
 * @returns {object[]} Normalized records
 */
export function normalizeRecords(records, coreColumns, options = {}) {
  const { idGeneration = 'native', idPrefix = '', systemId, systemPrefix } = options;
  const coreSet = new Set(coreColumns);

  return records.map(rec => {
    const normalized = {};
    const extended = new Map();

    // Write only property names sourced from the trusted coreSet, not from
    // the user-provided record keys, to avoid remote-property-injection.
    for (const key of coreSet) {
      if (Object.prototype.hasOwnProperty.call(rec, key)) {
        normalized[key] = coerceValue(rec[key]);
      }
    }
    // Collect non-core, non-reserved fields for extendedAttributes JSON.
    for (const [key, value] of Object.entries(rec)) {
      if (!coreSet.has(key) && key !== 'externalId') {
        extended.set(key, value);
      }
    }

    // Handle ID generation
    if (idGeneration === 'deterministic' && rec.externalId) {
      normalized.id = deterministicGuid(idPrefix, String(rec.externalId));
      normalized.externalId = String(rec.externalId);
    }

    // Resolve external-ID references (parent/child/resource/principal/identity/
    // context/member) to deterministic UUIDs so the generated FKs match the ids
    // the other endpoints created for the same externalId — see resolveExternalRefs.
    if (idGeneration === 'deterministic') {
      // Prefer the explicit systemPrefix the route recovers by stripping the
      // known entity suffix off idPrefix — it survives a system prefix that
      // itself contains hyphens (splitting on the first hyphen would resolve to
      // the wrong namespace, e.g. a ContextMembers_contextId_fkey violation).
      const sysPrefix = systemPrefix || idPrefix.split('-')[0];
      resolveExternalRefs(rec, normalized, coreSet, sysPrefix);
    }

    // Set systemId if provided, the record doesn't override it, AND the table has the column
    if (systemId !== undefined && normalized.systemId === undefined && coreSet.has('systemId')) {
      normalized.systemId = systemId;
    }

    // Pack extendedAttributes
    if (extended.size > 0) {
      const existing = normalized.extendedAttributes
        ? (typeof normalized.extendedAttributes === 'string'
          ? tryParseJson(normalized.extendedAttributes)
          : normalized.extendedAttributes)
        : {};
      normalized.extendedAttributes = JSON.stringify({ ...existing, ...Object.fromEntries(extended) });
    } else if (normalized.extendedAttributes && typeof normalized.extendedAttributes === 'object') {
      normalized.extendedAttributes = JSON.stringify(normalized.extendedAttributes);
    }

    return normalized;
  });
}

export function coerceValue(value) {
  if (value === null || value === undefined) return null;
  // Empty strings → null. Postgres rejects '' for typed columns (uuid,
  // timestamptz, integer, boolean). Treating them as null is always safe and
  // matches the intent of "this field was not supplied".
  if (value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

/**
 * Validate that a string is a valid UUID.
 */
export function isValidUuid(str) {
  return typeof str === 'string' && UUID_RE.test(str);
}
