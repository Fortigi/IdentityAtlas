// Pie charts inside an exported workbook.
//
// A report can declare charts — a pie of how its rows split over one column,
// counted or summed — and the xlsx download then opens with them on a "Charts"
// tab, right after the Summary. Like the pivots, this is keyed on the
// declaration and never on a report name.
//
// Each chart reads a small table written next to it on the same tab (category,
// value), so the numbers behind a slice are visible, copyable and stay correct
// if someone edits them. The table is computed here from the rows the Data tab
// holds, in the order categories first appear in them: a report that sorts its
// rows worst-first gets a legend that reads worst-first too.
//
// ExcelJS (4.4) writes no charts, so — the same way as xlsxPivots.js — the
// chart parts are added to the zip after ExcelJS has written it: one drawing on
// the Charts tab, holding one chart part per declared chart.

import JSZip from 'jszip';
import { insertBefore, relationship, relationships, xmlText } from './xlsxPivots.js';

export const CHARTS_SHEET = 'Charts';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const DRAWINGML = 'application/vnd.openxmlformats-officedocument.drawingml';
const BLANK_LABEL = '(blank)';
// Every chart gets this many rows of the tab, or more when its table is longer.
const BLOCK_ROWS = 24;
const CHART_FIRST_COL = 3;   // D — the table holds A:B, C is a gutter
const CHART_LAST_COL = 11;
const CHART_HEIGHT_ROWS = 22;

/**
 * One chart's numbers: each distinct category in first-appearance order, with
 * how many rows hold it — or, when the chart names a `value` column, the sum of
 * that column over those rows. A non-numeric value adds nothing.
 */
export function chartSeries(chart, rows) {
  const totals = new Map();
  for (const row of rows) {
    const raw = row?.[chart.category];
    const label = raw === null || raw === undefined || raw === '' ? BLANK_LABEL : String(raw);
    const add = chart.value ? Number(row[chart.value]) : 1;
    totals.set(label, (totals.get(label) || 0) + (Number.isFinite(add) ? add : 0));
  }
  return [...totals].map(([label, value]) => ({ label, value }));
}

/**
 * Where each chart sits on the tab: its table's first row (1-based, the header)
 * and the 0-based row its picture is anchored at. Blocks never overlap however
 * long a table is.
 */
export function chartLayout(seriesList) {
  let top = 1;
  return seriesList.map((series) => {
    const block = { headerRow: top, firstRow: top + 1, lastRow: top + series.length, anchorRow: top - 1 };
    top += Math.max(BLOCK_ROWS, series.length + 3);
    return block;
  });
}

/**
 * Write the Charts tab's tables with ExcelJS and return the plan the zip pass
 * needs. Returns null when there is nothing to chart, so no empty tab appears.
 */
export function writeChartTables(workbook, charts, rows) {
  const usable = (charts || []).filter(c => c?.category && rows.length);
  if (!usable.length) return null;
  const sheet = workbook.addWorksheet(CHARTS_SHEET);
  sheet.getColumn(1).width = 36;
  sheet.getColumn(2).width = 14;
  const seriesList = usable.map(chart => chartSeries(chart, rows));
  const layout = chartLayout(seriesList);
  usable.forEach((chart, i) => {
    const { headerRow } = layout[i];
    const header = sheet.getRow(headerRow);
    header.getCell(1).value = chart.title || chart.name || chart.category;
    header.getCell(2).value = chart.valueLabel || (chart.value ? 'Total' : 'Count');
    header.font = { bold: true };
    seriesList[i].forEach((point, p) => {
      const row = sheet.getRow(headerRow + 1 + p);
      row.getCell(1).value = point.label;
      row.getCell(2).value = point.value;
    });
  });
  return { sheetId: sheet.id, charts: usable.map((chart, i) => ({ chart, series: seriesList[i], ...layout[i] })) };
}

const sheetRef = (col, from, to) => `'${CHARTS_SHEET}'!$${col}$${from}:$${col}$${to}`;

function slicesXml(chart, series) {
  const colors = chart.colors || {};
  return series.map((point, i) => {
    const color = /^[0-9A-Fa-f]{6}$/.test(colors[point.label] || '') ? colors[point.label] : null;
    if (!color) return '';
    return `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:dPt>`;
  }).join('');
}

/** One pie chart part. The caches hold the numbers so the file renders before a recalc. */
export function pieChartXml({ chart, series, firstRow, lastRow }) {
  const title = xmlText(chart.title || chart.name || chart.category);
  const cats = series.map((p, i) => `<c:pt idx="${i}"><c:v>${xmlText(p.label)}</c:v></c:pt>`).join('');
  const vals = series.map((p, i) => `<c:pt idx="${i}"><c:v>${p.value}</c:v></c:pt>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>`
    + `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
    + '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:pieChart><c:varyColors val="1"/>'
    + `<c:ser><c:idx val="0"/><c:order val="0"/>${slicesXml(chart, series)}`
    + '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/>'
    + '<c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>'
    + `<c:cat><c:strRef><c:f>${sheetRef('A', firstRow, lastRow)}</c:f><c:strCache><c:ptCount val="${series.length}"/>${cats}</c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>${sheetRef('B', firstRow, lastRow)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${series.length}"/>${vals}</c:numCache></c:numRef></c:val>`
    + '</c:ser><c:firstSliceAng val="0"/></c:pieChart></c:plotArea>'
    + '<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>'
    + '</c:chart></c:chartSpace>';
}

function anchorXml({ anchorRow }, n) {
  const cell = (col, row) => `<xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff>`;
  return '<xdr:twoCellAnchor editAs="oneCell">'
    + `<xdr:from>${cell(CHART_FIRST_COL, anchorRow)}</xdr:from><xdr:to>${cell(CHART_LAST_COL, anchorRow + CHART_HEIGHT_ROWS)}</xdr:to>`
    + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n + 1}" name="Chart ${n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
    + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
    + `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="rIdChart${n}"/></a:graphicData></a:graphic>`
    + '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>';
}

/** The drawing on the Charts tab: one anchored frame per chart. */
export function drawingXml(plan) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${plan.charts.map((c, i) => anchorXml(c, i + 1)).join('')}</xdr:wsDr>`;
}

// CT_Worksheet puts <drawing> before these; anything else ExcelJS writes comes earlier.
const AFTER_DRAWING = ['<legacyDrawing', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst', '</worksheet>'];

/** Reference the drawing from the worksheet, in the place the schema requires. */
export function withDrawingRef(sheetXml) {
  const at = AFTER_DRAWING.map(tag => sheetXml.indexOf(tag)).filter(i => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) throw new Error('Unexpected worksheet part: no closing tag');
  const ns = sheetXml.includes(`xmlns:r="${NS_R}"`) ? '' : ` xmlns:r="${NS_R}"`;
  return `${sheetXml.slice(0, at)}<drawing${ns} r:id="rIdChartsDrawing"/>${sheetXml.slice(at)}`;
}

/**
 * Add the planned charts to a workbook ExcelJS has already written.
 * @param {Buffer} buffer  the .xlsx bytes
 * @param {Object|null} plan  what writeChartTables returned
 * @returns {Promise<Buffer>}
 */
export async function addCharts(buffer, plan) {
  if (!plan?.charts?.length) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const sheetPath = `xl/worksheets/sheet${plan.sheetId}.xml`;
  const sheetXml = await zip.file(sheetPath)?.async('string');
  if (!sheetXml) throw new Error(`No worksheet part for sheet ${plan.sheetId}`);
  zip.file(sheetPath, withDrawingRef(sheetXml));

  const relsPath = `xl/worksheets/_rels/sheet${plan.sheetId}.xml.rels`;
  const rel = relationship('rIdChartsDrawing', 'drawing', '../drawings/drawingCharts.xml');
  if (zip.file(relsPath)) await insertBefore(zip, relsPath, '</Relationships>', rel);
  else zip.file(relsPath, relationships(rel));

  zip.file('xl/drawings/drawingCharts.xml', drawingXml(plan));
  zip.file('xl/drawings/_rels/drawingCharts.xml.rels', relationships(
    plan.charts.map((_, i) => relationship(`rIdChart${i + 1}`, 'chart', `../charts/chartReport${i + 1}.xml`)).join('')));
  const types = [`<Override PartName="/xl/drawings/drawingCharts.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`];
  plan.charts.forEach((entry, i) => {
    zip.file(`xl/charts/chartReport${i + 1}.xml`, pieChartXml(entry));
    types.push(`<Override PartName="/xl/charts/chartReport${i + 1}.xml" ContentType="${DRAWINGML}.chart+xml"/>`);
  });
  await insertBefore(zip, '[Content_Types].xml', '</Types>', types.join(''));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
