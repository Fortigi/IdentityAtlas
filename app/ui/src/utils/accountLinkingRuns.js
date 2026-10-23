// Reading an account-linking run row.
//
// The three columns the name-only corroboration guard added are NULLABLE, and the null
// means "this run predates the feature" — which is a different statement from "the run
// looked and found none". Both readers below turn on that distinction, so they live here
// together rather than being re-derived at each call site.

/**
 * The run-completion line shown after a run finishes. Clauses for figures the run did not
 * measure are omitted rather than rendered as zero.
 */
export function completionNotice(run) {
  const parts = [
    `${run.linksCreated ?? 0} linked`,
    `${run.linksUpdated ?? 0} updated`,
    `${run.orphansRemaining ?? '—'} orphans remaining`,
  ];
  if (run.nameOnlyMatches != null) parts.push(`${run.nameOnlyMatches} name-only matches held for review`);
  if (run.linksRemoved != null) parts.push(`${run.linksRemoved} stale name-only links removed`);
  return `Linking complete — ${parts.join(', ')}.`;
}

/**
 * The newest completed run that actually recorded a name-only suggestions list, from a
 * `GET /api/account-linking/runs` payload (newest first). Runs still in flight and runs
 * from before the feature are skipped rather than read as "found none".
 */
export function latestNameOnlyRun(payload) {
  const runs = Array.isArray(payload?.data) ? payload.data : [];
  return runs.find(r => r.status === 'completed' && Array.isArray(r.nameOnlySuggestions)) ?? null;
}
