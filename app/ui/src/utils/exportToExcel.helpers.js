import { TYPE_COLORS as TYPE_COLORS_SRC, AP_COLORS } from './colors';
import { hexToArgb, thinBorder, setHeaderCell, safeCell } from './excelHelpers';
import { friendlyLabel } from './formatters';
import { contextNames } from './resourceContexts';
import { getApRoleBadge } from './accessPackageStyles';

// Derive Excel-friendly color format (no # prefix, uppercase) from shared TYPE_COLORS
export const TYPE_COLORS = Object.fromEntries(
  Object.entries(TYPE_COLORS_SRC).map(([key, val]) => [
    key,
    { bg: val.bg.replace('#', '').toUpperCase(), text: val.text.replace('#', '').toUpperCase().replace(/^FF/, '') },
  ])
);

export function getApColorHex(index) {
  return AP_COLORS[index % AP_COLORS.length];
}

// ---------- Column layout ----------

export function setColumnWidths(ws, { infoColCount, userCount, apCount, apColStart, metaColStart }) {
  ws.getColumn(1).width = 38;  // Resource Name
  ws.getColumn(2).width = 34;  // Contexts
  ws.getColumn(3).width = 38;  // GUID
  for (let u = 0; u < userCount; u++) {
    ws.getColumn(infoColCount + u + 1).width = 4;
  }
  for (let a = 0; a < apCount; a++) {
    ws.getColumn(apColStart + a).width = 4;
  }
  ws.getColumn(metaColStart).width = 5;      // #
  ws.getColumn(metaColStart + 1).width = 24; // Type
  ws.getColumn(metaColStart + 2).width = 30; // Description
}

// ---------- Header rows ----------

// One header row per sort attribute (matching the on-screen stacked headers),
// plus the AP banner on the first row. On-screen merged spans are written as the
// same value repeated across each column — user-name cells are NOT merged.
export function writeAttributeHeaders(ws, { attrs, headerLevels, infoColCount, userCount, users, apCount, apColStart }) {
  for (let L = 0; L < headerLevels; L++) {
    const hr = ws.getRow(L + 1);
    hr.height = 90;
    setHeaderCell(ws.getCell(L + 1, 1), friendlyLabel(String(attrs[L]).replace(/^ext\./, '')));
    for (let u = 0; u < userCount; u++) {
      const cell = ws.getCell(L + 1, infoColCount + u + 1);
      cell.value = safeCell((users[u].sortKeys && users[u].sortKeys[L]) || '(none)');
      cell.font = { size: 11, bold: true };
      cell.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      cell.border = thinBorder();
    }
  }

  writeApBanner(ws, { apCount, apColStart });
}

// AP banner on the first header row (single label over the AP block).
function writeApBanner(ws, { apCount, apColStart }) {
  if (apCount <= 0) return;
  if (apCount > 1) {
    ws.mergeCells(1, apColStart, 1, apColStart + apCount - 1);
  }
  const apBanner = ws.getCell(1, apColStart);
  apBanner.value = 'Governed (via Business Roles)';
  apBanner.font = { size: 11, bold: true, color: { argb: 'FF3730A3' } };
  apBanner.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
  apBanner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
  apBanner.border = thinBorder();
}

// Names row: resource info headers + user names + AP names + meta headers.
export function writeNamesRow(ws, { namesRow, infoColCount, userCount, users, apCount, apColStart, accessPackages, metaColStart }) {
  ws.getRow(namesRow).height = 80;

  setHeaderCell(ws.getCell(namesRow, 1), 'Resource Name');
  setHeaderCell(ws.getCell(namesRow, 2), 'Contexts');
  setHeaderCell(ws.getCell(namesRow, 3), 'GUID');

  for (let u = 0; u < userCount; u++) {
    const cell = ws.getCell(namesRow, infoColCount + u + 1);
    cell.value = safeCell(users[u].displayName);
    cell.font = { size: 11, bold: false };
    cell.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    cell.border = thinBorder();
  }

  // AP name headers on the names row (each AP gets a distinct color)
  for (let a = 0; a < apCount; a++) {
    const cell = ws.getCell(namesRow, apColStart + a);
    cell.value = safeCell(accessPackages[a].displayName);
    cell.font = { size: 11, bold: false };
    cell.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(getApColorHex(a)) } };
    cell.border = thinBorder();
  }

  setHeaderCell(ws.getCell(namesRow, metaColStart), '#', true);
  setHeaderCell(ws.getCell(namesRow, metaColStart + 1), 'Type', true);
  setHeaderCell(ws.getCell(namesRow, metaColStart + 2), 'Description', true);
}

// ---------- Data rows ----------

export function writeResourceRow(ws, group, rowNum, ctx) {
  ws.getRow(rowNum).height = 18;

  // Info columns: Resource Name | Contexts | GUID
  const nameCell = ws.getCell(rowNum, 1);
  nameCell.value = safeCell(group.displayName);
  nameCell.font = { size: 11 };
  nameCell.border = thinBorder();

  // Every context the resource belongs to — full list, unlike the on-screen
  // cell which caps at two chips plus a "+N" expander.
  const contextsCell = ws.getCell(rowNum, 2);
  contextsCell.value = safeCell(contextNames(group.contexts));
  contextsCell.font = { size: 11 };
  contextsCell.border = thinBorder();

  const guidCell = ws.getCell(rowNum, 3);
  guidCell.value = group.realGroupId || group.id;
  guidCell.font = { size: 11, color: { argb: 'FF9CA3AF' } };
  guidCell.border = thinBorder();

  writeIntersectionCells(ws, group, rowNum, ctx);

  // Meta columns (right side): # | Type | Description
  const countCell = ws.getCell(rowNum, ctx.metaColStart);
  countCell.value = group.memberCount;
  countCell.font = { size: 11 };
  countCell.alignment = { horizontal: 'center' };
  countCell.border = thinBorder();

  const typeCell = ws.getCell(rowNum, ctx.metaColStart + 1);
  typeCell.value = safeCell(group.groupType || '');
  typeCell.font = { size: 11, color: { argb: 'FF6B7280' } };
  typeCell.border = thinBorder();

  const descCell = ws.getCell(rowNum, ctx.metaColStart + 2);
  descCell.value = safeCell(group.description);
  descCell.font = { size: 11 };
  descCell.border = thinBorder();

  writeApRoleCells(ws, group, rowNum, ctx);
}

// Intersection cells: one per user, with membership letters and AP-managed fill.
function writeIntersectionCells(ws, group, rowNum, ctx) {
  const { userCount, users, infoColCount } = ctx;
  for (let u = 0; u < userCount; u++) {
    const user = users[u];
    const memberTypes = ctx.memberships.get(`${group.id}|${user.id}`);
    const excelCell = ws.getCell(rowNum, infoColCount + u + 1);

    writeMembershipContent(excelCell, memberTypes);
    applyManagedFill(excelCell, group, user, ctx);
    excelCell.border = thinBorder();
  }
}

// Cell content: a single type letter, or rich text with one colored letter per type.
function writeMembershipContent(excelCell, memberTypes) {
  if (!memberTypes || memberTypes.size === 0) return;

  const types = [...memberTypes];
  excelCell.alignment = { horizontal: 'center', vertical: 'middle' };

  if (types.length === 1 && TYPE_COLORS[types[0]]) {
    excelCell.value = types[0].charAt(0);
    excelCell.font = { size: 11, bold: true, color: { argb: 'FF' + TYPE_COLORS[types[0]].text } };
    return;
  }

  excelCell.value = {
    richText: types.map(t => ({
      text: TYPE_COLORS[t] ? t.charAt(0) : '?',
      font: { size: 11, bold: true, color: { argb: 'FF' + (TYPE_COLORS[t]?.bg || '374151') } },
    })),
  };
}

// Cell background: AP color for managed cells only; unmanaged cells stay white.
// For owner rows, use realGroupId since managedApMap uses real group IDs.
function applyManagedFill(excelCell, group, user, ctx) {
  const lookupGroupId = group.realGroupId || group.id;
  const cellKeyLower = `${lookupGroupId.toLowerCase()}|${user.id.toLowerCase()}`;
  const apIds = ctx.managedApMap?.get(cellKeyLower);
  if (!apIds || apIds.length === 0 || !ctx.apIdToIndex) return;

  const firstIdx = ctx.apIdToIndex.get(apIds[0]);
  // Palette color when the AP has a column index, else a fallback blue.
  const bgArgb = firstIdx != null ? hexToArgb(getApColorHex(firstIdx)) : 'FFDBEAFE';
  excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
}

// Access package cells (each AP column uses its own color). Every mapping the
// on-screen matrix badges is exported — the badge letter comes from the shared
// getApRoleBadge so the file can't disagree with the grid.
function writeApRoleCells(ws, group, rowNum, ctx) {
  const { apCount, accessPackages, apColStart } = ctx;
  const lookupGid = group.realGroupId || group.id;
  for (let a = 0; a < apCount; a++) {
    const apKey = `${lookupGid.toUpperCase()}|${accessPackages[a].id.toLowerCase()}`;
    const roleName = ctx.apGroupMap?.get(apKey);
    const apCell = ws.getCell(rowNum, apColStart + a);

    if (roleName) {
      apCell.value = getApRoleBadge(roleName).letter;
      apCell.font = { size: 11, bold: true };
      apCell.alignment = { horizontal: 'center', vertical: 'middle' };
      apCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(getApColorHex(a)) } };
    }
    apCell.border = thinBorder();
  }
}

// ---------- Legend sheet ----------

export function buildLegendSheet(wb, { activeFilters, filterFields, shareUrl }) {
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
    legendWs.getCell(r, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colors.bg } };
    legendWs.getCell(r, 2).alignment = { horizontal: 'center' };
    legendWs.getCell(r, 2).border = thinBorder();

    legendWs.getCell(r, 3).value = '#' + colors.bg;
    legendWs.getCell(r, 3).font = { size: 11 };
    legendWs.getCell(r, 3).border = thinBorder();
  });

  writeFilterLegend(legendWs, { activeFilters, filterFields });
  writeShareUrl(legendWs, { activeFilters, shareUrl });
}

// Active filters block below the membership legend.
function writeFilterLegend(legendWs, { activeFilters, filterFields }) {
  if (!activeFilters || activeFilters.length === 0) return;

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

// Shareable link that reproduces the exact matrix view with all filters applied.
function writeShareUrl(legendWs, { activeFilters, shareUrl }) {
  if (!shareUrl) return;

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

// ---------- Download ----------

export async function triggerDownload(wb, activeFilters) {
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
