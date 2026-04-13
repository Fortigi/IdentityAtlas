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

export function friendlyLabel(key) {
  if (key === 'id') return 'GUID';
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}
