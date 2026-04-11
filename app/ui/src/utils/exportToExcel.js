import ExcelJS from 'exceljs';
import { TYPE_COLORS as TYPE_COLORS_SRC, AP_COLORS } from './colors';
import { hexToArgb, thinBorder, setHeaderCell } from './excelHelpers';

/**
 * Exports the matrix view to an Excel workbook matching the on-screen layout.
 *
 * Layout:
 *   Row 1: (3 blank info cols) | Job Title merged headers | AP banner | # | % | Type | Description
 *   Row 2: (empty) | Category | Group Name | user names... | AP names... | # | % | Type | Description
 *   Row 3+: group rows with colored cells
 *
 * Plus a "Legend" sheet showing membership types and active filters.
 */

// Derive Excel-friendly color format (no # prefix, uppercase) from shared TYPE_COLORS
const TYPE_COLORS = Object.fromEntries(
  Object.entries(TYPE_COLORS_SRC).map(([key, val]) => [
    key,
    { bg: val.bg.replace('#', '').toUpperCase(), text: val.text.replace('#', '').toUpperCase().replace(/^FF/, '') },
  ])
);

export async function exportToExcel({ users, orderedGroups, memberships, managedApMap, apIdToIndex, activeFilters, filterFields, accessPackages = [], apGroupMap, shareUrl }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Identity Atlas';
  wb.created = new Date();

  const ws = wb.addWorksheet('Role Mining Matrix', {
    views: [{ state: 'frozen', xSplit: 3, ySplit: 2 }],
  });

  const infoColCount = 3; // Resource Name | Type | GUID (matching UI left columns)
  const userCount = users.length;
  const apCount = accessPackages.length;

  // AP columns sit right after users (matching on-screen layout), meta cols at the end
  const apColStart = infoColCount + userCount + 1; // 1-based
  const metaColStart = apColStart + apCount;       // 1-based

  // ---------- Column widths ----------
  ws.getColumn(1).width = 38;  // Resource Name
  ws.getColumn(2).width = 24;  // Type
  ws.getColumn(3).width = 38;  // GUID
  for (let u = 0; u < userCount; u++) {
    ws.getColumn(infoColCount + u + 1).width = 4;
  }
  for (let a = 0; a < apCount; a++) {
    ws.getColumn(apColStart + a).width = 4;
  }
  ws.getColumn(metaColStart).width = 5;     // #
  ws.getColumn(metaColStart + 1).width = 30; // Description

  // ===== ROW 1: Job titles (merged) =====
  const row1 = ws.getRow(1);
  row1.height = 90;

  // Build job title spans from ordered users
  const jobTitleSpans = [];
  let i = 0;
  while (i < users.length) {
    const title = users[i].jobTitle || '';
    let span = 1;
    while (i + span < users.length && (users[i + span].jobTitle || '') === title) {
      span++;
    }
    jobTitleSpans.push({ title, span, startIndex: i });
    i += span;
  }

  // Merge & style job title header cells (neutral gray)
  for (const jts of jobTitleSpans) {
    const startCol = infoColCount + jts.startIndex + 1;
    const endCol = startCol + jts.span - 1;
    if (jts.span > 1) {
      ws.mergeCells(1, startCol, 1, endCol);
    }
    const cell = ws.getCell(1, startCol);
    cell.value = jts.title || '(no title)';
    cell.font = { size: 11, bold: true };
    cell.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF3F4F6' },
    };
    cell.border = thinBorder();
  }

  // Row 1 access package banner (between users and meta)
  if (apCount > 0) {
    if (apCount > 1) {
      ws.mergeCells(1, apColStart, 1, apColStart + apCount - 1);
    }
    const apBanner = ws.getCell(1, apColStart);
    apBanner.value = 'Business Roles (SOLL)';
    apBanner.font = { size: 11, bold: true, color: { argb: 'FF3730A3' } };
    apBanner.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
    apBanner.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E7FF' },
    };
    apBanner.border = thinBorder();
  }

  // Row 1 meta headers (right side)
  setHeaderCell(ws.getCell(1, metaColStart), '#', true);
  setHeaderCell(ws.getCell(1, metaColStart + 1), 'Description', true);

  // ===== ROW 2: User display names =====
  const row2 = ws.getRow(2);
  row2.height = 80;

  setHeaderCell(ws.getCell(2, 1), 'Resource Name');
  setHeaderCell(ws.getCell(2, 2), 'Type');
  setHeaderCell(ws.getCell(2, 3), 'GUID');

  for (let u = 0; u < userCount; u++) {
    const cell = ws.getCell(2, infoColCount + u + 1);
    cell.value = users[u].displayName;
    cell.font = { size: 11, bold: false };
    cell.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF3F4F6' },
    };
    cell.border = thinBorder();
  }

  // Row 2 access package name headers (each AP gets a distinct color)
  for (let a = 0; a < apCount; a++) {
    const cell = ws.getCell(2, apColStart + a);
    cell.value = accessPackages[a].displayName;
    cell.font = { size: 11, bold: false };
    cell.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: hexToArgb(getApColorHex(a)) },
    };
    cell.border = thinBorder();
  }

  // ===== ROW 3+: Group rows =====
  orderedGroups.forEach((group, gIdx) => {
    const rowNum = gIdx + 3;
    const row = ws.getRow(rowNum);
    row.height = 18;

    // Info columns: Resource Name | Type | GUID
    const nameCell = ws.getCell(rowNum, 1);
    nameCell.value = group.displayName;
    nameCell.font = { size: 11 };
    nameCell.border = thinBorder();

    const typeCell = ws.getCell(rowNum, 2);
    typeCell.value = group.groupType || '';
    typeCell.font = { size: 11, color: { argb: 'FF6B7280' } };
    typeCell.border = thinBorder();

    const guidCell = ws.getCell(rowNum, 3);
    guidCell.value = group.realGroupId || group.id;
    guidCell.font = { size: 11, color: { argb: 'FF9CA3AF' } };
    guidCell.border = thinBorder();

    // Intersection cells
    for (let u = 0; u < userCount; u++) {
      const cellKey = `${group.id}|${users[u].id}`;
      const memberTypes = memberships.get(cellKey);
      const hasMembership = memberTypes && memberTypes.size > 0;

      const excelCell = ws.getCell(rowNum, infoColCount + u + 1);

      // Cell content
      if (hasMembership) {
        const types = [...memberTypes];
        excelCell.alignment = { horizontal: 'center', vertical: 'middle' };

        if (types.length === 1 && TYPE_COLORS[types[0]]) {
          excelCell.value = types[0].charAt(0);
          excelCell.font = { size: 11, bold: true, color: { argb: 'FF' + TYPE_COLORS[types[0]].text } };
        } else {
          // Rich text: each letter gets its own type color
          excelCell.value = {
            richText: types.map(t => ({
              text: TYPE_COLORS[t] ? t.charAt(0) : '?',
              font: { size: 11, bold: true, color: { argb: 'FF' + (TYPE_COLORS[t]?.bg || '374151') } },
            })),
          };
        }
      }

      // Cell background: AP color for managed cells only; unmanaged cells stay white
      // For owner rows, use realGroupId since managedApMap uses real group IDs
      const lookupGroupId = group.realGroupId || group.id;
      const cellKeyLower = `${lookupGroupId.toLowerCase()}|${users[u].id.toLowerCase()}`;
      const apIds = managedApMap?.get(cellKeyLower);
      if (apIds && apIds.length > 0 && apIdToIndex) {
        const firstIdx = apIdToIndex.get(apIds[0]);
        let bgArgb = null;
        if (firstIdx != null) {
          bgArgb = hexToArgb(getApColorHex(firstIdx));
        } else {
          bgArgb = 'FFDBEAFE'; // fallback blue for managed without index
        }
        if (bgArgb) excelCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bgArgb },
        };
        // Provisioning gap: check each AP's resource role against the user's actual membership
        const lookupGid = (group.realGroupId || group.id).toUpperCase();
        const isGap = apIds.some(apId => {
          const role = apGroupMap?.get(`${lookupGid}|${apId}`) || 'Member';
          const expectsEligible = role.toLowerCase().includes('eligible');
          if (expectsEligible) return !memberTypes || !memberTypes.has('Eligible');
          return !memberTypes || !memberTypes.has('Direct');
        });
        }

      excelCell.border = thinBorder();
    }

    // Meta columns (right side): # | Description
    const countCell = ws.getCell(rowNum, metaColStart);
    countCell.value = group.memberCount;
    countCell.font = { size: 11 };
    countCell.alignment = { horizontal: 'center' };
    countCell.border = thinBorder();

    const descCell = ws.getCell(rowNum, metaColStart + 1);
    descCell.value = group.description;
    descCell.font = { size: 11 };
    descCell.border = thinBorder();

    // Access package cells (each AP column uses its own color)
    const isOwnerRow = !!group.realGroupId;
    const lookupGid = group.realGroupId || group.id;
    for (let a = 0; a < apCount; a++) {
      const apKey = `${lookupGid.toUpperCase()}|${accessPackages[a].id.toLowerCase()}`;
      const roleName = apGroupMap?.get(apKey);
      const apCell = ws.getCell(rowNum, apColStart + a);

      // Owner rows only show Owner roles; regular rows only show non-Owner roles
      const roleIsOwner = (roleName || '').toLowerCase().includes('owner');
      const showRole = roleName && (isOwnerRow ? roleIsOwner : !roleIsOwner);
      if (showRole) {
        const lower = (roleName || '').toLowerCase();
        apCell.value = lower.includes('owner') ? 'O' : lower.includes('eligible') ? 'E' : 'D';
        apCell.font = { size: 11, bold: true };
        apCell.alignment = { horizontal: 'center', vertical: 'middle' };
        apCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: hexToArgb(getApColorHex(a)) },
        };
      }
      apCell.border = thinBorder();
    }
  });

  // ===== Legend Sheet =====
  const legendWs = wb.addWorksheet('Legend');
  legendWs.getColumn(1).width = 18;
  legendWs.getColumn(2).width = 10;
  legendWs.getColumn(3).width = 14;

  // Membership type legend
  setHeaderCell(legendWs.getCell(1, 1), 'Membership Type');
  setHeaderCell(legendWs.getCell(1, 2), 'Letter');
  setHeaderCell(legendWs.getCell(1, 3), 'Color');

  Object.entries(TYPE_COLORS).forEach(([type, colors], idx) => {
    const r = idx + 2;
    legendWs.getCell(r, 1).value = type;
    legendWs.getCell(r, 1).font = { size: 11 };
    legendWs.getCell(r, 1).border = thinBorder();

    legendWs.getCell(r, 2).value = type.charAt(0);
    legendWs.getCell(r, 2).font = { size: 11, bold: true, color: { argb: 'FF' + colors.text } };
    legendWs.getCell(r, 2).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF' + colors.bg },
    };
    legendWs.getCell(r, 2).alignment = { horizontal: 'center' };
    legendWs.getCell(r, 2).border = thinBorder();

    legendWs.getCell(r, 3).value = '#' + colors.bg;
    legendWs.getCell(r, 3).font = { size: 11 };
    legendWs.getCell(r, 3).border = thinBorder();
  });

  // Filters info
  if (activeFilters && activeFilters.length > 0) {
    const filterStart = Object.keys(TYPE_COLORS).length + 3;
    setHeaderCell(legendWs.getCell(filterStart, 1), 'Active Filters');
    setHeaderCell(legendWs.getCell(filterStart, 2), 'Value');

    activeFilters.forEach((af, idx) => {
      const r = filterStart + idx + 1;
      const field = filterFields?.find(f => f.key === af.field);
      legendWs.getCell(r, 1).value = field?.label || af.field;
      legendWs.getCell(r, 1).font = { size: 11, bold: true };
      legendWs.getCell(r, 1).border = thinBorder();

      legendWs.getCell(r, 2).value = af.value;
      legendWs.getCell(r, 2).font = { size: 11 };
      legendWs.getCell(r, 2).border = thinBorder();
    });
  }

  // Shareable URL
  if (shareUrl) {
    // Find next available row after membership legend + filters
    const legendRows = Object.keys(TYPE_COLORS).length + 1; // legend rows including header
    const filterRows = (activeFilters && activeFilters.length > 0)
      ? activeFilters.length + 2 // header + spacer + rows
      : 0;
    const urlRow = legendRows + filterRows + 2;

    setHeaderCell(legendWs.getCell(urlRow, 1), 'Shareable Link');
    const urlCell = legendWs.getCell(urlRow, 2);
    legendWs.mergeCells(urlRow, 2, urlRow, 3);
    urlCell.value = { text: shareUrl, hyperlink: shareUrl };
    urlCell.font = { size: 11, color: { argb: 'FF2563EB' }, underline: true };
    urlCell.border = thinBorder();

    const noteCell = legendWs.getCell(urlRow + 1, 1);
    noteCell.value = 'Open this link to reproduce the exact same matrix view with all filters applied.';
    legendWs.mergeCells(urlRow + 1, 1, urlRow + 1, 3);
    noteCell.font = { size: 11, italic: true, color: { argb: 'FF6B7280' } };
  }

  // ===== Generate & download =====
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const filterLabel = activeFilters?.length > 0
    ? activeFilters.map(f => f.value).join('-')
    : 'all';
  a.download = `role-mining-${filterLabel}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Helpers ----------

function getApColorHex(index) {
  return AP_COLORS[index % AP_COLORS.length];
}
