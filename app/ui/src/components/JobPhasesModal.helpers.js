// ─── JobPhasesModal — pure helpers & display config ───────────────────────────
// Value-shaping and lookup tables for the crawler job-detail modal. Kept out of
// the .jsx so each piece is a tiny, separately-testable unit and the modal's
// render function stays lean.

// Human-readable phase duration: sub-second in ms, seconds up to a minute, then
// minutes + seconds. Null/undefined renders as an em-dash.
export function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

// Human-readable byte size for the trace size readout.
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Text colour for the job status line — failed/completed get a semantic colour,
// everything else stays neutral.
const STATUS_TEXT_CLASS = {
  failed: 'text-red-600 dark:text-red-400',
  completed: 'text-green-600 dark:text-green-400',
};
export function statusTextClass(status) {
  return STATUS_TEXT_CLASS[status] || 'text-gray-600 dark:text-gray-400';
}

// Sync-mode pill shown next to the job title. Absent/unknown mode renders no pill.
export const SYNC_MODE_BADGES = {
  full: {
    label: 'full',
    title: 'Full sync: re-fetches everything.',
    className:
      'px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  },
  delta: {
    label: 'delta',
    title: 'Delta sync: fetches only what changed.',
    className:
      'px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
  },
};

// Status dot colour + tooltip per phase status; unknown status falls back to a
// neutral, untitled dot.
export const PHASE_DOTS = {
  ok: { cls: 'bg-green-500', title: 'Succeeded' },
  failed: { cls: 'bg-red-500', title: 'Failed' },
  skipped: { cls: 'bg-gray-400', title: 'Skipped' },
};
export const DEFAULT_DOT = { cls: 'bg-gray-300 dark:bg-gray-600', title: undefined };
