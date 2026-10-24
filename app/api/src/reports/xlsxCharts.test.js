// Unit tests for the pie charts in an xlsx download.
//
// ExcelJS cannot read charts back, so — like the pivot tests — these open the
// zip. The discriminating checks are the ones Excel would otherwise only show by
// drawing the wrong pie: the table beside each chart holds the right totals in
// the right order, the chart's ranges point at exactly that table, and every
// part is wired (worksheet → drawing → chart, plus content types). That Excel
// itself opens the result was checked by opening it in Excel; that cannot run here.

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { EXPORT_FORMATS } from './export.js';
import {
  CHARTS_SHEET, addCharts, chartLayout, chartSeries, drawingXml, pieChartXml, withDrawingRef,
} from './xlsxCharts.js';

const ROWS = [
  { status: 'Missed', members: 10 },
  { status: 'Done', members: 2 },
  { status: 'Missed', members: 5 },
  { status: null, members: 1 },
  { status: 'Done', members: 'n/a' },
];
const REPORT = {
  displayName: 'Chart Sample',
  columns: [{ key: 'status', label: 'Status' }, { key: 'members', label: 'Members' }],
  rows: ROWS,
  total: ROWS.length,
  generatedAt: '2026-10-22T10:00:00.000Z',
  charts: [
    { name: 'By status', type: 'pie', category: 'status', title: 'Roles by status', colors: { Missed: 'DC2626', Done: 'zzz' } },
    { name: 'Members', type: 'pie', category: 'status', value: 'members', valueLabel: 'Members' },
  ],
};

const xlsx = report => EXPORT_FORMATS.xlsx.serialize(report);
const part = (zip, path) => zip.file(path)?.async('string');

describe('chartSeries', () => {
  it('counts rows per category in first-appearance order, with blanks as (blank)', () => {
    expect(chartSeries({ category: 'status' }, ROWS)).toEqual([
      { label: 'Missed', value: 2 }, { label: 'Done', value: 2 }, { label: '(blank)', value: 1 },
    ]);
  });

  it('sums the value column instead when one is named, ignoring what is not a number', () => {
    expect(chartSeries({ category: 'status', value: 'members' }, ROWS)).toEqual([
      { label: 'Missed', value: 15 }, { label: 'Done', value: 2 }, { label: '(blank)', value: 1 },
    ]);
  });
});

describe('chartLayout', () => {
  it('gives every chart its own block, longer when its table is longer', () => {
    const short = Array.from({ length: 3 }, () => ({}));
    const long = Array.from({ length: 30 }, () => ({}));
    expect(chartLayout([short, long, short])).toEqual([
      { headerRow: 1, firstRow: 2, lastRow: 4, anchorRow: 0 },
      { headerRow: 25, firstRow: 26, lastRow: 55, anchorRow: 24 },
      { headerRow: 58, firstRow: 59, lastRow: 61, anchorRow: 57 },
    ]);
  });
});

describe('the workbook', () => {
  it('puts a Charts tab right after the Summary, holding each chart\'s table', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await xlsx(REPORT));
    expect(workbook.worksheets.map(s => s.name)).toEqual(['Summary', CHARTS_SHEET, 'Data']);
    const sheet = workbook.getWorksheet(CHARTS_SHEET);
    const cells = r => [sheet.getCell(`A${r}`).value, sheet.getCell(`B${r}`).value];
    expect([1, 2, 3, 4].map(cells)).toEqual([['Roles by status', 'Count'], ['Missed', 2], ['Done', 2], ['(blank)', 1]]);
    expect([25, 26, 27, 28].map(cells)).toEqual([['Members', 'Members'], ['Missed', 15], ['Done', 2], ['(blank)', 1]]);
  });

  it('wires worksheet → drawing → one chart per declaration, with content types', async () => {
    const zip = await JSZip.loadAsync(await xlsx(REPORT));
    const sheetXml = await part(zip, 'xl/worksheets/sheet2.xml');
    expect(sheetXml).toContain('<drawing r:id="rIdChartsDrawing"/>');
    expect(await part(zip, 'xl/worksheets/_rels/sheet2.xml.rels')).toContain('Target="../drawings/drawingCharts.xml"');
    const drawingRels = await part(zip, 'xl/drawings/_rels/drawingCharts.xml.rels');
    expect(drawingRels).toContain('Id="rIdChart1"');
    expect(drawingRels).toContain('Target="../charts/chartReport2.xml"');
    const types = await part(zip, '[Content_Types].xml');
    expect(types).toContain('PartName="/xl/charts/chartReport1.xml"');
    expect(types).toContain('PartName="/xl/charts/chartReport2.xml"');
    expect(types).toContain('PartName="/xl/drawings/drawingCharts.xml"');
  });

  it('points each chart at exactly its own table, and colours only valid colours', async () => {
    const zip = await JSZip.loadAsync(await xlsx(REPORT));
    const first = await part(zip, 'xl/charts/chartReport1.xml');
    expect(first).toContain(`<c:f>'Charts'!$A$2:$A$4</c:f>`);
    expect(first).toContain(`<c:f>'Charts'!$B$2:$B$4</c:f>`);
    expect(first).toContain('<a:t>Roles by status</a:t>');
    expect(first).toContain('<c:dPt><c:idx val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="DC2626"/>');
    expect(first.match(/<c:dPt>/g)).toHaveLength(1);   // "zzz" is not a colour
    const second = await part(zip, 'xl/charts/chartReport2.xml');
    expect(second).toContain(`<c:f>'Charts'!$B$26:$B$28</c:f>`);
    expect(second).toContain('<c:pt idx="0"><c:v>15</c:v></c:pt>');
  });

  it('adds no Charts tab when the report declares none, has no rows, or names no category', async () => {
    for (const report of [{ ...REPORT, charts: [] }, { ...REPORT, rows: [] }, { ...REPORT, charts: [{ name: 'x', type: 'pie' }] }, { ...REPORT, charts: undefined }]) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await xlsx(report));
      expect(workbook.worksheets.map(s => s.name)).toEqual(['Summary', 'Data']);
    }
  });

  it('keeps pivots working next to charts', async () => {
    const report = { ...REPORT, pivots: [{ name: 'Pivot', rows: ['status'], values: ['members'] }] };
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await xlsx(report));
    expect(workbook.worksheets.map(s => s.name)).toEqual(['Summary', CHARTS_SHEET, 'Data', 'Pivot']);
    const zip = await JSZip.loadAsync(await xlsx(report));
    expect(await part(zip, 'xl/pivotCache/pivotCacheDefinition1.xml')).toContain('sheet="Data"');
  });
});

describe('the parts on their own', () => {
  it('escapes a title and a category that are not XML-safe', () => {
    const xml = pieChartXml({ chart: { category: 'a<b' }, series: [{ label: 'R&D', value: 1 }], firstRow: 2, lastRow: 2 });
    expect(xml).toContain('<a:t>a&lt;b</a:t>');
    expect(xml).toContain('<c:v>R&amp;D</c:v>');
  });

  it('falls back to the name for a title', () => {
    expect(pieChartXml({ chart: { name: 'N', category: 'c' }, series: [], firstRow: 2, lastRow: 1 })).toContain('<a:t>N</a:t>');
  });

  it('anchors each chart on its own block, numbered from 1', () => {
    const xml = drawingXml({ charts: [{ anchorRow: 0 }, { anchorRow: 20 }] });
    expect(xml).toContain('<xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row>');
    expect(xml).toContain('<xdr:to><xdr:col>11</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>42</xdr:row>');
    expect(xml).toContain('r:id="rIdChart2"');
    expect(xml).toContain('name="Chart 1"');
  });

  it('places the drawing reference before the parts the schema puts after it', () => {
    expect(withDrawingRef('<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><pageMargins/><tableParts/></worksheet>'))
      .toBe('<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><pageMargins/><drawing r:id="rIdChartsDrawing"/><tableParts/></worksheet>');
    expect(withDrawingRef('<worksheet><pageMargins/></worksheet>'))
      .toBe('<worksheet><pageMargins/><drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdChartsDrawing"/></worksheet>');
    expect(() => withDrawingRef('<worksheet>')).toThrow('Unexpected worksheet part');
  });

  it('returns the bytes untouched when there is no plan', async () => {
    const bytes = Buffer.from('not a zip');
    expect(await addCharts(bytes, null)).toBe(bytes);
    expect(await addCharts(bytes, { charts: [] })).toBe(bytes);
  });

  it('fails loudly when the planned sheet is not in the workbook', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types></Types>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(addCharts(bytes, { sheetId: 9, charts: [{}] })).rejects.toThrow('No worksheet part for sheet 9');
  });
});
