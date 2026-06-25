// Distinguish a genuinely-absent optional schema object (tolerable on older
// deployments) from a real error. Several read endpoints wrap optional-schema
// queries in try/catch; they should swallow ONLY a missing table/column/view and
// let every other error (a typo'd column, a malformed query, a connection
// failure, a logic bug) surface instead of silently returning empty/zero — which
// previously masked real failures (audit finding Q2).
//
// Codes are Postgres SQLSTATEs; the pg driver sets them on err.code and the
// db/connection shim passes errors through unwrapped, so they're preserved.

const MISSING_SCHEMA_CODES = new Set([
  '42P01', // undefined_table (also covers missing views/matviews)
  '42703', // undefined_column
  '42704', // undefined_object (e.g. a missing type)
]);

export function isMissingSchema(err) {
  return !!err && MISSING_SCHEMA_CODES.has(err.code);
}
