/**
 * Validation helpers — pure per-envelope and per-record validators.
 *
 * Each helper returns an array of error strings (empty when the input passes),
 * so the callers in validation.js can concatenate them without tracking state.
 * Kept free of any DB / schema-registry dependency: everything the checks need
 * is passed in, which keeps them individually testable.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Canonical base64: a whole number of 4-character groups, padding only at the
// end. Deliberately strict — Buffer.from() accepts malformed input and
// silently drops the bad tail, so a loose check here would store truncated
// bytes that only surface as a corrupt image much later.
//
// The length check is what makes the grouping rule cheap. Expressing it in the
// pattern instead — `^(?:[A-Za-z0-9+/]{4})*(?:..==|...=)?$` — nests a
// quantifier inside a quantified group, which backtracks catastrophically on a
// long almost-matching string. These values arrive from a crawler and may be
// hundreds of kilobytes, so that is a denial-of-service, not a style point.
// Below, the payload class and `=` are disjoint, so matching is linear.
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function isBase64(value) {
  if (value.length % 4 !== 0) return false;
  return BASE64_CHARS_RE.test(value);
}

/** A field counts as "not supplied" when it is undefined, null, or empty string. */
export function isBlank(val) {
  return val === undefined || val === null || val === '';
}

// ── Envelope helpers ─────────────────────────────────────────────────────────

/** systemId is required on every endpoint except the systems endpoint. */
export function validateSystemId(body, entityType) {
  if (entityType === 'systems') return [];
  if (body.systemId === undefined || body.systemId === null) {
    return ['systemId is required'];
  }
  return [];
}

/**
 * Validate the `records` field. PowerShell's ConvertTo-Json serialises an empty
 * array as `null`, so null/undefined records are treated as an empty array.
 * A present-but-non-array records field fails first (and short-circuits the
 * other checks, matching the original if/else-if chain).
 *
 * A body carrying neither records nor deletedIds fails — UNLESS it is a FULL
 * sync. A full sync's records ARE the complete set, and a source can legitimately
 * hold nothing: an empty full batch is how a crawler says "this scope is now
 * empty, delete what you have", and tools/crawlers/shared/Invoke-CrawlerIngest.ps1
 * sends exactly that ("Empty full-sync batch so the server scoped-deletes stale
 * rows"). Rejecting it made a collection impossible to reconcile down to zero —
 * a SCIM endpoint that legitimately serves no groups failed its whole sync.
 *
 * A DELTA batch with neither is still an error: delta means "here is what
 * changed", and nothing-at-all says nothing at all.
 */
export function validateRecordsArray(body) {
  const { records, deletedIds } = body;

  if (records !== undefined && records !== null && !Array.isArray(records)) {
    return ['records must be an array'];
  }

  const recordsEmpty = !records || records.length === 0;
  const deletesEmpty = !Array.isArray(deletedIds) || deletedIds.length === 0;
  if (recordsEmpty && deletesEmpty && body.syncMode !== 'full') {
    // Empty records are fine when the caller is only sending delta deletes, or
    // when this is a full sync of a source that now holds nothing (see above).
    return ['records array cannot be empty'];
  }

  if (Array.isArray(records) && records.length > 50000) {
    return ['records array cannot exceed 50,000 items'];
  }

  return [];
}

/** deletedIds, when provided, must be an array of at most 50,000 items. */
export function validateDeletedIdsArray(body) {
  const { deletedIds } = body;
  if (deletedIds === undefined) return [];
  if (!Array.isArray(deletedIds)) return ['deletedIds must be an array when provided'];
  if (deletedIds.length > 50000) return ['deletedIds array cannot exceed 50,000 items'];
  return [];
}

/** syncMode / idGeneration / idPrefix option checks. */
export function validateEnvelopeOptions(body) {
  const errors = [];

  if (body.syncMode && !['full', 'delta'].includes(body.syncMode)) {
    errors.push('syncMode must be "full" or "delta"');
  }

  if (body.idGeneration && !['native', 'deterministic'].includes(body.idGeneration)) {
    errors.push('idGeneration must be "native" or "deterministic"');
  }

  if (body.idGeneration === 'deterministic' && !body.idPrefix) {
    errors.push('idPrefix is required when idGeneration is "deterministic"');
  }

  return errors;
}

// ── Record helpers ───────────────────────────────────────────────────────────

/**
 * Required fields — skipped in delta mode. Graph's /delta endpoints return
 * partial records (only changed fields), so a required field like `displayName`
 * may legitimately be missing on an update; the engine's COALESCE upsert
 * preserves the existing value.
 */
export function validateRequiredFields(rec, i, schema, syncMode) {
  if (syncMode === 'delta') return [];
  const errors = [];
  for (const field of schema.required) {
    if (isBlank(rec[field])) {
      errors.push(`Record ${i}: missing required field '${field}'`);
    }
  }
  return errors;
}

/**
 * requiredOneOf — at least one of each listed field group must be present.
 * Used by assignments/relationships to accept either the UUID field or the
 * external-ID alias.
 */
export function validateRequiredOneOf(rec, i, schema) {
  if (!schema.requiredOneOf) return [];
  const errors = [];
  for (const group of schema.requiredOneOf) {
    const hasAny = group.fields.some(f => !isBlank(rec[f]));
    if (!hasAny) {
      errors.push(`Record ${i}: one of [${group.fields.join(', ')}] is required`);
    }
  }
  return errors;
}

/**
 * XOR check: the resource-assignments endpoint only accepts principal-side
 * fields. Catches accidental mixing before the DB constraint produces a
 * cryptic error.
 */
export function validateAssignmentXor(rec, i, entityType) {
  if (entityType !== 'resource-assignments') return [];
  const hasIdentitySide = !isBlank(rec.identityId) || !isBlank(rec.identityExternalId);
  if (hasIdentitySide) {
    return [`Record ${i}: identityId/identityExternalId not allowed here — use /ingest/resource-assignments-identity`];
  }
  return [];
}

/** ID field must be a UUID unless deterministic generation is in use. */
export function validateIdField(rec, i, schema, idGeneration) {
  if (!schema.idField || idGeneration === 'deterministic') return [];
  const idVal = rec[schema.idField];
  if (idVal !== undefined && idVal !== null && !UUID_RE.test(String(idVal))) {
    return [`Record ${i}: '${schema.idField}' must be a valid UUID (got '${String(idVal).slice(0, 50)}')`];
  }
  return [];
}

/** Per-field type / length / enum constraints for a single field value. */
export function validateFieldValue(field, def, val, i, schema, idGeneration) {
  const errors = [];

  if (def.type === 'string' && typeof val !== 'string') {
    errors.push(`Record ${i}: '${field}' must be a string`);
  }
  // Only error on a bad UUID if this isn't the ID field under deterministic generation.
  if (
    def.type === 'uuid'
    && !UUID_RE.test(String(val))
    && (field !== schema.idField || idGeneration !== 'deterministic')
  ) {
    errors.push(`Record ${i}: '${field}' must be a valid UUID`);
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
  // Binary payloads travel as base64 because JSON has no binary type. Reject
  // anything that isn't — an unpadded or otherwise malformed string would be
  // silently truncated by Buffer.from(..., 'base64') and stored as corrupt
  // bytes that only surface as a broken image much later.
  if (def.type === 'base64') {
    if (typeof val !== 'string') {
      errors.push(`Record ${i}: '${field}' must be a base64 string`);
    } else if (!isBase64(val)) {
      errors.push(`Record ${i}: '${field}' is not valid base64`);
    } else if (def.maxBytes && Buffer.byteLength(val, 'base64') > def.maxBytes) {
      errors.push(`Record ${i}: '${field}' exceeds max size of ${def.maxBytes} bytes`);
    }
  }

  return errors;
}

/** Field type / length / enum constraints across every schema field. */
export function validateFieldConstraints(rec, i, schema, idGeneration) {
  const errors = [];
  for (const [field, def] of Object.entries(schema.fields)) {
    const val = rec[field];
    if (val === undefined || val === null) continue;
    errors.push(...validateFieldValue(field, def, val, i, schema, idGeneration));
  }
  return errors;
}

/** All checks for a single record, in the original order. */
export function validateRecord(rec, i, schema, entityType, idGeneration, syncMode) {
  return [
    ...validateRequiredFields(rec, i, schema, syncMode),
    ...validateRequiredOneOf(rec, i, schema),
    ...validateAssignmentXor(rec, i, entityType),
    ...validateIdField(rec, i, schema, idGeneration),
    ...validateFieldConstraints(rec, i, schema, idGeneration),
  ];
}
