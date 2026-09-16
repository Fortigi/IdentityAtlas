// ─── CrawlersPage — pure helpers ──────────────────────────────────────────────
// Value-shaping for the job-progress card. Kept out of the .jsx so each piece is
// a tiny, separately-testable unit and the card's render function stays lean.

// Job statuses that no longer poll — the progress card stops its clock on these.
export const JOB_PROGRESS_TERMINAL = ['completed', 'failed', 'cancelled'];

// A job's `progress` arrives as either an already-parsed object, a JSON string,
// or nothing. Normalise to a plain object.
export function parseProgress(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

// Freshness bucket for the "last update Xs ago" line: unknown when we've never
// seen an update, "stale" once >60s have passed with no fresh progress (a hint
// the run may be hung), otherwise "fresh"/"normal".
export function computeStaleness(secondsSince) {
  if (secondsSince == null) return null;
  if (secondsSince < 10) return 'fresh';
  if (secondsSince < 60) return 'normal';
  return 'stale';
}

// Derive every display value the progress card needs from the raw job. Pure —
// `now` is passed in so the caller owns the clock. Returns null when there's no
// job to show.
export function deriveJobProgressDisplay(job, configLabel, now) {
  if (!job) return null;
  const progress = parseProgress(job.progress);
  const updatedAt = progress.updatedAt ? new Date(progress.updatedAt) : null;
  const secondsSince = updatedAt
    ? Math.max(0, Math.round((now - updatedAt.getTime()) / 1000))
    : null;
  const staleness = computeStaleness(secondsSince);
  return {
    status: job.status,
    // Header label on every card so two running crawlers are distinguishable at
    // a glance. Falls back to the bare job type when the config name isn't known.
    header: configLabel || job.jobType,
    pct: progress.pct || 0,
    step: progress.step || 'Waiting...',
    detail: progress.detail || '',
    errorMessage: job.errorMessage || 'Unknown error',
    updatedAt,
    secondsSince,
    staleness,
    stalenessColor: staleness === 'stale' ? 'text-amber-700' : 'text-blue-700',
  };
}
