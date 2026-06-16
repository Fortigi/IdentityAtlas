import ExcelJS from 'exceljs';
import { setHeaderCell, safeCell } from './excelHelpers';

// Export a roll-up matrix (rows = resources or business roles, columns = the
// roll-up groups, plus optional business-role count columns, then # and
// Description) to a real .xlsx workbook — matching the on-screen grid.
//
//   rowNoun      'Resource' | 'Business role'
//   columns      [{ key, label, path }]  the roll-up group columns; `path` is the
//                full header trail (e.g. ['Algemene Directie','CEO']) for the
//                layered org-chart / attribute views — one Excel header row per
//                level, with merged on-screen spans written as repeated values.
//   roleColumns  [{ id, label }]    optional business-role count columns
//   rows         [{ label, description, total, cell(colKey), roleCell(roleId) }]
//   sheetName    worksheet title
//   fileName     download name (.xlsx)
// Build (but don't download) the workbook — separated so it can be unit-tested
// without a DOM.
export function buildRollupWorkbook({ rowNoun, columns, roleColumns = [], rows, sheetName = 'Roll-up' }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Identity Atlas';

  const groupCount = columns.length;
  const roleCount = roleColumns.length;
  const totalCol = 1 + groupCount + roleCount + 1; // 1-based: rowNoun + groups + roles + '#'
  const descCol = totalCol + 1;

  // One header row per group-column header level. Merged spans on screen are
  // written as the same value repeated across each column (Excel cells are NOT
  // merged). Paths are top-aligned, matching the on-screen stack.
  const headerLevels = Math.max(1, ...columns.map(c => (c.path?.length || 1)));
  const ws = wb.addWorksheet(sheetName.slice(0, 31), { views: [{ state: 'frozen', xSplit: 1, ySplit: headerLevels }] });

  for (let L = 0; L < headerLevels; L++) {
    const isBottom = L === headerLevels - 1;
    const hr = ws.getRow(L + 1);
    if (isBottom) setHeaderCell(hr.getCell(1), rowNoun);
    columns.forEach((c, i) => {
      const path = (c.path && c.path.length) ? c.path : [c.label];
      const val = L < path.length ? path[L] : '';
      setHeaderCell(hr.getCell(2 + i), safeCell(val), true);
    });
    if (isBottom) {
      roleColumns.forEach((r, i) => setHeaderCell(hr.getCell(2 + groupCount + i), safeCell(r.label), true));
      setHeaderCell(hr.getCell(totalCol), '#', true);
      setHeaderCell(hr.getCell(descCol), 'Description');
    }
    hr.height = isBottom ? 110 : 90;
  }

  // ── Data rows ──
  const firstData = headerLevels + 1;
  rows.forEach((r, ri) => {
    const row = ws.getRow(firstData + ri);
    row.getCell(1).value = safeCell(r.label);
    columns.forEach((c, i) => {
      const v = r.cell(c.key);
      if (v) row.getCell(2 + i).value = v;
    });
    roleColumns.forEach((rc, i) => {
      const v = r.roleCell ? r.roleCell(rc.id) : 0;
      if (v) row.getCell(2 + groupCount + i).value = v;
    });
    if (r.total) row.getCell(totalCol).value = r.total;
    if (r.description) row.getCell(descCol).value = safeCell(r.description);
  });

  // ── Column widths ──
  ws.getColumn(1).width = 42;
  for (let i = 0; i < groupCount + roleCount; i++) ws.getColumn(2 + i).width = 6;
  ws.getColumn(totalCol).width = 6;
  ws.getColumn(descCol).width = 44;
  return wb;
}

// Build the workbook and trigger a .xlsx download.
export async function exportRollupToExcel({ fileName = 'matrix-rollup.xlsx', ...opts }) {
  const wb = buildRollupWorkbook(opts);
  wb.created = new Date();
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}
