// Pure helpers for RiskScoreSection — parsing, formatting, and the small
// data→class/sign lookups that keep the component's JSX flat. Kept in a sibling
// module so RiskScoreSection.jsx stays component-only (Vite fast-refresh) and so
// these branchy utilities can be unit-tested directly.

// Parse a value that may be a JSON string, an already-parsed object, or an
// em-dash placeholder. Returns null on empty/placeholder/invalid input.
export function parseJSON(val) {
  if (!val || val === '—') return null;
  try { return typeof val === 'string' ? JSON.parse(val) : val; }
  catch { return null; }
}

// Format a "scored at" timestamp for display; null when absent, raw string when unparseable.
export function formatScoredAt(val) {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d)) return String(val);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Clamp a raw score to the displayable 0–100 range.
export function clampScore(n) {
  return Math.max(0, Math.min(100, n));
}

// Leading '+' for positive numbers (negatives already carry their own sign).
export function signPrefix(n) {
  return n > 0 ? '+' : '';
}

// Badge classes for a classifier-match score chip (high / medium / low bands).
export function classifierScoreClass(score) {
  if (score >= 70) return 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300';
  if (score >= 40) return 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300';
  return 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400';
}

// Render a single explanation reason, which may be a string or a {reason} object.
export function reasonText(r) {
  if (typeof r === 'string') return r;
  return r.reason || JSON.stringify(r);
}

// Turn a camelCase layer key (e.g. "riskPropagation") into spaced words for a heading.
export function humanizeLayerKey(key) {
  return key.replace(/([A-Z])/g, ' $1').trim();
}

// Text colour for the live adjustment readout: red raises risk, green lowers it.
export function adjustmentColorClass(adjustment) {
  if (adjustment > 0) return 'text-red-600 dark:text-red-400';
  if (adjustment < 0) return 'text-green-600 dark:text-green-400';
  return 'text-gray-500 dark:text-gray-400';
}

// Tint for the summary override badge — red when it raises risk, green when it lowers it.
export function overrideBadgeClass(override) {
  return override > 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700';
}
