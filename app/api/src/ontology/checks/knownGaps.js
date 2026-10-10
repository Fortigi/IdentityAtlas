// Known, accepted inconsistencies between the ontology and the implementation.
//
// The ontology describes what exists; where the implementation contradicts
// itself (an ingest field with no column, a foreign key that cannot hold its
// target's id) the check reports it, and a human decides. A decision to accept
// it for now is recorded in ontology/validation.json → knownGaps with a reason.
//
// The list is a ratchet: an entry that no longer matches a finding fails the
// check as stale, so a fixed gap has to be removed and the list only shrinks.

/**
 * @param {Array<{code:string, subject:string, message:string}>} findings
 * @param {Array<{code:string, subject:string, reason:string, scope?:string}>} gaps
 * @param {'static'|'database'} scope  which run this is; a gap is only judged
 *        stale by the run that can observe it (default scope: static)
 * @returns {{ errors: object[], accepted: object[] }}
 */
export function applyKnownGaps(findings, gaps = [], scope = 'static') {
  const inScope = gaps.filter(g => (g.scope ?? 'static') === scope);
  const key = (f) => `${f.code}|${f.subject}`;
  const gapKeys = new Set(inScope.map(key));
  const seen = new Set();
  const errors = [];
  const accepted = [];
  for (const f of findings) {
    if (gapKeys.has(key(f))) { accepted.push(f); seen.add(key(f)); } else errors.push(f);
  }
  for (const g of inScope) {
    if (!seen.has(key(g))) {
      errors.push({ code: 'stale-known-gap', subject: `${g.code} ${g.subject}`, message: 'ontology/validation.json lists this as a known gap but it no longer occurs — remove the entry' });
    }
  }
  for (const g of inScope) {
    if (typeof g.reason !== 'string' || g.reason.trim().length < 20) {
      errors.push({ code: 'known-gap-without-reason', subject: `${g.code} ${g.subject}`, message: 'every known gap needs a written reason (20+ characters)' });
    }
  }
  return { errors, accepted };
}
