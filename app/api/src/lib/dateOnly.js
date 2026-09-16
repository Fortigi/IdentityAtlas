// A timestamp as the calendar day it fell on, or null.
//
// Report cells and notices say "measured on 2026-09-14", not "2026-09-14
// T03:17:44.912Z": the extra precision is noise in a table and misleading in a
// staleness claim, where the useful granularity is a day either way. Accepts
// whatever the driver hands back (a Date for timestamptz, a string from JSON)
// and returns null rather than "Invalid Date" for anything unparseable, so a
// missing value renders as the table's own em-dash.
export function toDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
