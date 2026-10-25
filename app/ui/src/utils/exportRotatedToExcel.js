import ExcelJS from 'exceljs';
import { setHeaderCell, safeCell, thinBorder } from './excelHelpers';
import { writeMembershipContent, buildLegendSheet, triggerDownload } from './exportToExcel.helpers';

// Export the rotated (subjects-as-rows) matrix to an .xlsx workbook matching
// the on-screen grid:
//
//   Row 1: (Subjects) | resource type per column (rotated, repeated per column)
//   Row 2: Display Name | Department | Job Title | resource names (rotated)
//   Row 3+: one row per subject, membership letters per resource
//
// Plus the same "Legend" sheet as the default matrix export.
//
//   users      [{ id, displayName, department, jobTitle }]   (row order)
//   resources  [{ id, displayName, resourceType }]           (column order)
//   cellMap    Map("userId|resourceId" -> { types: Set, managed: bool })

const INFO_COLS = 3; // Display Name | Department | Job Title
const MANAGED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };

// Build (but don't download) the workbook — separated so it can be unit-tested
// without a DOM.
export function buildRotatedWorkbook({ users, resources, cellMap, shareUrl }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Identity Atlas';

  const ws = wb.addWorksheet('Role Mining Matrix', {
    views: [{ state: 'frozen', xSplit: INFO_COLS, ySplit: 2 }],
  });

  // ── Header rows ──
  const typeRow = ws.getRow(1);
  const nameRow = ws.getRow(2);
  setHeaderCell(typeRow.getCell(1), 'Subjects');
  ['Display Name', 'Department', 'Job Title'].forEach((label, i) => setHeaderCell(nameRow.getCell(1 + i), label));
  resources.forEach((r, i) => {
    const col = INFO_COLS + 1 + i;
    setHeaderCell(typeRow.getCell(col), safeCell(r.resourceType || '(no type)'), true);
    setHeaderCell(nameRow.getCell(col), safeCell(r.displayName), true);
  });
  typeRow.height = 90;
  nameRow.height = 110;

  // ── Subject rows ──
  users.forEach((u, ui) => {
    const row = ws.getRow(3 + ui);
    [u.displayName, u.department, u.jobTitle].forEach((v, i) => {
      const c = row.getCell(1 + i);
      c.value = safeCell(v || '');
      c.border = thinBorder();
    });
    resources.forEach((r, ri) => {
      const c = row.getCell(INFO_COLS + 1 + ri);
      const cell = cellMap.get(`${u.id}|${r.id}`);
      writeMembershipContent(c, cell?.types);
      if (cell?.managed) c.fill = MANAGED_FILL;
      c.border = thinBorder();
    });
  });

  // ── Column widths ──
  ws.getColumn(1).width = 32;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 22;
  for (let i = 0; i < resources.length; i++) ws.getColumn(INFO_COLS + 1 + i).width = 4;

  buildLegendSheet(wb, { activeFilters: [], filterFields: [], shareUrl });
  return wb;
}

// Build the workbook and trigger a .xlsx download.
export async function exportRotatedToExcel(opts) {
  const wb = buildRotatedWorkbook(opts);
  wb.created = new Date();
  await triggerDownload(wb, []);
}
