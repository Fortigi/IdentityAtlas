/**
 * Shared Excel export helpers used by both matrix and access-package exporters.
 */

export function hexToArgb(hex) {
  const clean = hex.replace('#', '');
  if (clean.length === 6) return 'FF' + clean.toUpperCase();
  if (clean.length === 8) return clean.toUpperCase();
  return 'FFFFFFFF';
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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
