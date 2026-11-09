// Context upload — what an upload will do to the list's contexts.
//
//   diffContexts(records, existing) → { created, updated, unchanged, missingIds }
//
// Pure. `records` are the contexts the file produces (records.js), `existing`
// the list's synced contexts now (lists.js existingContexts). A context is
// matched by id — the deterministic id of (list, tree, key), so matching by id
// IS matching by key. It is `updated` when any field the upload writes differs:
// name, parent, owner, member kind or attributes. `missingIds` are the
// contexts of the list the file no longer has.

const norm = (v) => (v === undefined || v === '' ? null : v);

// Attributes compared as data: key order and a stored-as-string JSON don't count.
function canonical(attrs) {
  let v = attrs;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v; } }
  if (!v || typeof v !== 'object' || Object.keys(v).length === 0) return null;
  return JSON.stringify(Object.keys(v).sort().map(k => [k, v[k]]));
}

export function contextChanged(record, row) {
  return norm(record.displayName) !== norm(row.displayName)
    || norm(record.parentContextId) !== norm(row.parentContextId)
    || norm(record.ownerUserId) !== norm(row.ownerUserId)
    || record.targetType !== row.targetType
    || canonical(record.extendedAttributes) !== canonical(row.extendedAttributes);
}

export function diffContexts(records, existing) {
  const byId = new Map(existing.map(r => [r.id, r]));
  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const rec of records) {
    const row = byId.get(rec.id);
    if (!row) counts.created++;
    else if (contextChanged(rec, row)) counts.updated++;
    else counts.unchanged++;
  }
  const incoming = new Set(records.map(r => r.id));
  const missingIds = existing.filter(r => !incoming.has(r.id)).map(r => r.id);
  return { ...counts, missingIds };
}
