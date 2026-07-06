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

    // Handle external-ID-based references for resource-relationships and
    // resource-assignments. When the caller sends parentExternalId /
    // childExternalId / resourceExternalId / principalExternalId, convert
    // them to deterministic UUIDs using the same prefix namespace so the FKs
    // match the IDs generated for the parent/child entities.
    if (idGeneration === 'deterministic') {
      // Cross-entity ID resolution: derive the prefix used to generate the
      // target entity's deterministic GUID. The convention is that the ingest
      // caller sets idPrefix = "<systemPrefix>-<endpointSuffix>", e.g.
      // "<sys>-resources", "<sys>-principals", "<sys>-resource-assignments".
      //
      // To resolve a resourceExternalId we need "<sys>-resources" — i.e. keep
      // the system prefix and swap the entity suffix. Same for principals.
      //
      // Prefer the explicit systemPrefix the route recovers by stripping the
      // known entity suffix off idPrefix — that survives a system prefix that
      // itself contains hyphens. Splitting on the first hyphen only works when
      // the system prefix is hyphen-free, and otherwise resolves references to
      // the wrong namespace, causing FK violations (e.g.
      // ContextMembers_contextId_fkey on the context-members upsert).
      const sysPrefix = systemPrefix || idPrefix.split('-')[0];

      // A parentExternalId names the record's parent in the SAME entity family,
      // so it must resolve into that family's namespace and land on that table's
      // parent FK column — not always Resources. A Context's parent is another
      // Context ("<sys>-contexts" → parentContextId); a resource-relationship's
      // parent is another Resource ("<sys>-resources" → parentResourceId). Key
      // off whichever parent column the target table actually has (coreSet) so a
      // context tree's parentExternalId no longer mis-resolves to a Resources id
      // (which left the hierarchy unset — the parent link only survived as raw
      // text in extendedAttributes).
      if (rec.parentExternalId && coreSet.has('parentContextId') && !normalized.parentContextId) {
        normalized.parentContextId = deterministicGuid(`${sysPrefix}-contexts`, String(rec.parentExternalId));
      }
      if (rec.parentExternalId && coreSet.has('parentResourceId') && !normalized.parentResourceId) {
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
      // Context-member references (ingest/context-members). The context endpoint
      // generates context IDs under "<sys>-contexts" and each member entity under
      // "<sys>-<entity>", so re-derive the same namespaces here to make the FKs
      // line up. The CSV crawler sends these externalIds expecting resolution
      // here — see tools/crawlers/csv/Start-CSVCrawler.ps1 → ContextMembers.csv.
      if (rec.contextExternalId && !normalized.contextId) {
        normalized.contextId = deterministicGuid(`${sysPrefix}-contexts`, String(rec.contextExternalId));
      }
      if (rec.memberExternalId && !normalized.memberId) {
        // memberId's namespace depends on what kind of entity the member is.
        const memberNs = { Identity: 'identities', Principal: 'principals', Resource: 'resources' }[rec.memberType];
        if (memberNs) {
          normalized.memberId = deterministicGuid(`${sysPrefix}-${memberNs}`, String(rec.memberExternalId));
        }
      }
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
