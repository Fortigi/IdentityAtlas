export { formatDateOnly as formatDate } from './formatters';

// Excel/CSV formula-injection guard (security finding M-05). A cell whose text
// starts with = + - @ (or a leading tab/CR) is interpreted as a formula by
// spreadsheet apps. Synced display names / descriptions are externally
// influenced, so prefix a single quote to force literal text. Non-string values
// (numbers, rich-text/formula objects) pass through unchanged.
export function safeCell(value) {
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

export function hexToArgb(hex) {
  const clean = hex.replace('#', '');
  if (clean.length === 6) return 'FF' + clean.toUpperCase();
  if (clean.length === 8) return clean.toUpperCase();
  return 'FFFFFFFF';
}


export function thinBorder(omitBottom = false, omitTop = false) {
  return {
    top:    omitTop    ? undefined : { style: 'thin', color: { argb: 'FFD1D5DB' } },
    left:   { style: 'thin', color: { argb: 'FFD1D5DB' } },
    bottom: omitBottom ? undefined : { style: 'thin', color: { argb: 'FFD1D5DB' } },
    right:  { style: 'thin', color: { argb: 'FFD1D5DB' } },
  };
}

export function setHeaderCell(cell, value, rotated = false) {
  cell.value = value;
  cell.font = { size: 11, bold: true, color: { argb: 'FF374151' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
  cell.border = thinBorder();
  if (rotated) {
    cell.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
  }
}
