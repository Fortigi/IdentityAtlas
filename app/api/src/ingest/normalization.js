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

/**
 * Normalize a batch of records for a given entity type.
 *
 * - Assigns deterministic GUIDs if idGeneration === 'deterministic'
 * - Coerces types (booleans to 0/1, dates to ISO strings)
 * - Packs non-core fields into extendedAttributes JSON
 *
 * @param {object[]} records - Raw records from the API request
 * @param {string[]} coreColumns - Known columns in the target table
 * @param {object} options
 * @param {string} options.idGeneration - 'native' (default) or 'deterministic'
 * @param {string} options.idPrefix - Namespace for deterministic GUIDs
 * @param {number} options.systemId - System ID to set on each record
 * @returns {object[]} Normalized records
 */
export function normalizeRecords(records, coreColumns, options = {}) {
  const { idGeneration = 'native', idPrefix = '', systemId } = options;
  const coreSet = new Set(coreColumns);

  return records.map(rec => {
    const normalized = {};
    const extended = {};

    for (const [key, value] of Object.entries(rec)) {
      if (coreSet.has(key)) {
        normalized[key] = coerceValue(value);
      } else if (key !== 'externalId') {
        // Non-core fields go into extendedAttributes
        extended[key] = value;
      }
    }

    // Handle ID generation
    if (idGeneration === 'deterministic' && rec.externalId) {
      normalized.id = deterministicGuid(idPrefix, String(rec.externalId));
      normalized.externalId = String(rec.externalId);
    }

    // Handle external-ID-based references for resource-relationships and
    // resource-assignments. When the caller sends parentExternalId /
    // childExternalId / resourceExternalId / principalExternalId, convert
    // them to deterministic UUIDs using the same prefix namespace so the FKs
    // match the IDs generated for the parent/child entities.
    if (idGeneration === 'deterministic') {
      // Cross-entity ID resolution: derive the prefix used to generate the
      // target entity's deterministic GUID. The convention is that the ingest
      // caller sets idPrefix = "<systemType>-<endpointSuffix>", e.g.:
      //   resources:              "CSV-resources"
      //   principals:             "CSV-principals"
      //   resource-assignments:   "CSV-resource-assignments"
      //   resource-relationships: "CSV-resource-relationships"
      //   certifications:         "CSV-certifications"
      //
      // To resolve a resourceExternalId we need "CSV-resources" — i.e. keep
      // the system prefix (everything before the first hyphen) and swap the
      // entity suffix. Same for principals.
      const sysPrefix = idPrefix.split('-')[0]; // e.g. "CSV", "Omada"

      if (rec.parentExternalId && !normalized.parentResourceId) {
        normalized.parentResourceId = deterministicGuid(`${sysPrefix}-resources`, String(rec.parentExternalId));
      }
      if (rec.childExternalId && !normalized.childResourceId) {
        normalized.childResourceId = deterministicGuid(`${sysPrefix}-resources`, String(rec.childExternalId));
      }
      // Identity-member external IDs
      if (rec.identityExternalId && !normalized.identityId) {
        normalized.identityId = deterministicGuid(`${sysPrefix}-identities`, String(rec.identityExternalId));
      }
      if (rec.userExternalId && !normalized.principalId) {
        normalized.principalId = deterministicGuid(`${sysPrefix}-principals`, String(rec.userExternalId));
      }
      if (rec.resourceExternalId && !normalized.resourceId) {
        normalized.resourceId = deterministicGuid(`${sysPrefix}-resources`, String(rec.resourceExternalId));
      }
      if (rec.principalExternalId && !normalized.principalId) {
        normalized.principalId = deterministicGuid(`${sysPrefix}-principals`, String(rec.principalExternalId));
      }
    }

    // Set systemId if provided, the record doesn't override it, AND the table has the column
    if (systemId !== undefined && normalized.systemId === undefined && coreSet.has('systemId')) {
      normalized.systemId = systemId;
    }

    // Pack extendedAttributes
    if (Object.keys(extended).length > 0) {
      const existing = normalized.extendedAttributes
        ? (typeof normalized.extendedAttributes === 'string'
          ? tryParseJson(normalized.extendedAttributes)
          : normalized.extendedAttributes)
        : {};
      normalized.extendedAttributes = JSON.stringify({ ...existing, ...extended });
    } else if (normalized.extendedAttributes && typeof normalized.extendedAttributes === 'object') {
      normalized.extendedAttributes = JSON.stringify(normalized.extendedAttributes);
    }

    return normalized;
  });
}

function coerceValue(value) {
  if (value === null || value === undefined) return null;
  // Empty strings → null. Postgres rejects '' for typed columns (uuid,
  // timestamptz, integer, boolean). Treating them as null is always safe and
  // matches the intent of "this field was not supplied".
  if (value === '') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
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
