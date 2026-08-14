import ExcelJS from 'exceljs';
import {
  setColumnWidths,
  writeAttributeHeaders,
  writeNamesRow,
  writeResourceRow,
  buildLegendSheet,
  triggerDownload,
} from './exportToExcel.helpers';

/**
 * Exports the matrix view to an Excel workbook matching the on-screen layout.
 *
 * Layout:
 *   Row 1: (3 blank info cols) | Job Title merged headers | AP banner | # | Type | Description
 *   Row 2: (empty) | Category | Group Name | user names... | AP names... | # | Type | Description
 *   Row 3+: group rows with colored cells
 *
 * Plus a "Legend" sheet showing membership types and active filters.
 */
export async function exportToExcel({ users, orderedGroups, memberships, managedApMap, apIdToIndex, activeFilters, filterFields, accessPackages = [], apGroupMap, shareUrl, sortAttributes = [] }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Identity Atlas';
  wb.created = new Date();

  const infoColCount = 3; // Resource Name | Contexts | GUID (matching UI left columns)
  const userCount = users.length;
  const apCount = accessPackages.length;

  // One header row per sort attribute (matching the on-screen stacked headers),
  // then the user-names row.
  const attrs = (Array.isArray(sortAttributes) && sortAttributes.length)
    ? sortAttributes.map(s => s.attribute) : ['department'];
  const headerLevels = attrs.length;
  const namesRow = headerLevels + 1; // 1-based row of the user-names header

  const ws = wb.addWorksheet('Role Mining Matrix', {
    views: [{ state: 'frozen', xSplit: 3, ySplit: namesRow }],
  });

  // AP columns sit right after users (matching on-screen layout), meta cols at the end
  const apColStart = infoColCount + userCount + 1; // 1-based
  const metaColStart = apColStart + apCount;       // 1-based

  // Shared layout + data lookups passed to every row writer.
  const ctx = {
    infoColCount, userCount, users, apCount, apColStart, accessPackages, metaColStart,
    memberships, managedApMap, apIdToIndex, apGroupMap,
  };

  setColumnWidths(ws, ctx);
  writeAttributeHeaders(ws, { attrs, headerLevels, ...ctx });
  writeNamesRow(ws, { namesRow, ...ctx });

  orderedGroups.forEach((group, gIdx) => {
    writeResourceRow(ws, group, gIdx + namesRow + 1, ctx);
  });

  buildLegendSheet(wb, { activeFilters, filterFields, shareUrl });

  await triggerDownload(wb, activeFilters);
}
