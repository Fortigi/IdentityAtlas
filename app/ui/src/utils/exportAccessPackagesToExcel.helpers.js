import { formatDate, thinBorder, safeCell } from './excelHelpers';

// Build the 9 AP-detail column values (repeated on every row of a package).
export function buildApValues(pkg) {
  return [
    pkg.displayName || '',
    pkg.catalogName || '',
    pkg.category?.name || '',
    pkg.assignmentType || '',
    pkg.totalAssignments ?? '',
    pkg.complianceStatus || (pkg.hasReviewConfigured ? 'Pending first review' : 'Not required'),
    formatDate(pkg.lastReviewDate),
    pkg.lastReviewedBy || '',
    pkg.description || '',
  ];
}

// Split a "GroupName (Role)" entry into its two cell values.
export function splitGroupRole(entry) {
  const parenIdx = entry.lastIndexOf(' (');
  if (parenIdx !== -1 && entry.endsWith(')')) {
    return { groupName: entry.slice(0, parenIdx), roleName: entry.slice(parenIdx + 2, -1) };
  }
  return { groupName: entry, roleName: '' };
}

// Font for a role name (Owner=purple, Member=blue, else default).
const ROLE_FONT_COLORS = { Owner: 'FF6B21A8', Member: 'FF1D4ED8' };
export function roleFont(roleName) {
  const argb = ROLE_FONT_COLORS[roleName];
  return argb ? { size: 11, color: { argb } } : { size: 11 };
}

// Write the AP-detail columns for one row — same values copied into every row.
export function writeApCells(ws, rowNum, apValues) {
  apValues.forEach((val, c) => {
    const cell = ws.getCell(rowNum, c + 1);
    cell.value = safeCell(val);
    cell.font = { size: 11 };
    cell.border = thinBorder();
    if (c === 4) cell.alignment = { horizontal: 'center', vertical: 'top' };
    else cell.alignment = { vertical: 'top', wrapText: c === 8 };
  });
}

// Write the Group & Role columns for one resource-role entry.
export function writeGroupRoleCells(ws, rowNum, apColCount, roleEntry) {
  const { groupName, roleName } = splitGroupRole(roleEntry);

  const groupCell = ws.getCell(rowNum, apColCount + 1);
  groupCell.value = safeCell(groupName);
  groupCell.font = { size: 11 };
  groupCell.border = thinBorder();

  const roleCell = ws.getCell(rowNum, apColCount + 2);
  roleCell.value = safeCell(roleName);
  roleCell.font = roleFont(roleName);
  roleCell.border = thinBorder();
}

// Border-only empty cells for a row with no resource roles.
export function writeEmptyResourceCells(ws, rowNum, startCol, endCol) {
  for (let c = startCol; c < endCol; c++) {
    ws.getCell(rowNum, c + 1).border = thinBorder();
  }
}
