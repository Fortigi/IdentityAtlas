// A message that may carry caller-supplied text (a record value, a system name,
// a database error quoting one), folded onto one line so it cannot start a new,
// forged log entry (CWE-117). Unlike printableForLog it keeps the text readable:
// spaces and non-ASCII survive, only line breaks become a single space.
export function oneLineForLog(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ');
}
