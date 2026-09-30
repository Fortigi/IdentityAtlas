// A message that may carry caller-supplied text (a record value, a system name,
// a database error quoting one), folded onto one line so it cannot start a new,
// forged log entry (CWE-117). Unlike printableForLog it keeps the text readable:
// spaces and non-ASCII survive, only line breaks become a single space.
//
// Two steps on purpose: a space goes in ahead of each run of line breaks, then
// the breaks themselves are removed. CodeQL's js/log-injection only accepts the
// REMOVAL of \r / \n as sanitising (as printableForLog does) — a single
// replace-with-space gives the same text but leaves every caller flagged.
export function oneLineForLog(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' $&')
    .replace(/[\r\n]/g, '');
}
