export function formatDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (isNaN(d)) return String(val);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatValue(val) {
  if (val === null || val === undefined) return '\u2014';
  if (val === true) return 'Yes';
  if (val === false) return 'No';
  if (typeof val === 'object') return JSON.stringify(val, null, 2);
  if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}T/)) return formatDate(val);
  return String(val);
}

export function computeHistoryDiffs(history) {
  if (!history || history.length <= 1) return [];
  const diffs = [];
  for (let i = 0; i < history.length - 1; i++) {
    const newer = history[i];
    const older = history[i + 1];
    const changes = [];
    const allKeys = new Set([...Object.keys(newer), ...Object.keys(older)]);
    for (const key of allKeys) {
      if (key === 'ValidFrom' || key === 'ValidTo' || key === 'id') continue;
      const oldVal = formatValue(older[key]);
      const newVal = formatValue(newer[key]);
      if (oldVal !== newVal) {
        changes.push({ field: key, from: oldVal, to: newVal });
      }
    }
    if (changes.length > 0) {
      diffs.push({ date: newer.ValidFrom, changes });
    }
  }
  return diffs;
}

export function formatDateOnly(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDurationSeconds(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function formatDurationMs(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function formatRelativeTime(isoStr) {
  if (!isoStr) return 'never';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return 'in the future';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1)  return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)   return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30)    return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12)  return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatCompactNumber(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(0) + 'k';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function friendlyLabel(key) {
  if (key === 'id') return 'GUID';
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

// Server-resolved display name for an extendedAttributes key, or null. Re-exported
// here so a label call site needs one import, and so it sits next to the humaniser
// it overrides — an extension-derived name is shown VERBATIM (`sAMAccountName`),
// never word-split by friendlyLabel into "S A M Account Name".
export { attributeLabel } from './attributeLabels';
