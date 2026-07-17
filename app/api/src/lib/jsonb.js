// Normalise a value read from a JSONB column.
//
// node-postgres already parses JSONB columns into JS values, so a naive
// `JSON.parse` on the returned value throws (JSON.parse of an object stringifies
// to "[object Object]"). A few code paths still carry a raw JSON *string*
// (legacy/shim data), so accept both: pass an already-parsed value through
// untouched, JSON.parse a string, and return null for null/invalid input.
//
// Replaces the copy-pasted `typeof x === 'string' ? JSON.parse : x` guards and
// the two buggy `JSON.parse(<object>)` sites that threw on every request
// (audit Q9).
export function parseJsonbColumn(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
