// Pure helpers for MatrixFilterSummary — the strip above the matrix (#1202).

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// "45 users × 39 resources · 127 assignments" — the three live numbers of what the
// matrix selects. Identities are counted as identities, not users. Empty string
// before the counts are known, so the strip renders nothing rather than zeros.
export function stripCountsLabel(preview, rowType) {
  if (!preview) return '';
  const subjects = rowType === 'identity'
    ? plural(preview.subjectCount ?? 0, 'identity', 'identities')
    : plural(preview.subjectCount ?? 0, 'user', 'users');
  const resources = plural(preview.resourceCount ?? 0, 'resource', 'resources');
  const assignments = plural(preview.assignmentCount ?? 0, 'assignment', 'assignments');
  return `${subjects} × ${resources} · ${assignments}`;
}
