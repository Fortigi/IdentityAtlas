// Unit tests for the pivot tables in an xlsx download.
//
// ExcelJS cannot read pivot tables back, so these open the zip itself. The
// discriminating assertion is the round trip: the pivot cache is decoded back
// into rows and compared with the rows it was written from — a record pointing
// at the wrong item, or two values folded that should not be, changes a number
// Excel then sums, and nothing else would notice. (That Excel itself accepts
// these parts was checked by opening the output in Excel; that cannot run here.)

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { EXPORT_FORMATS } from './export.js';
import {
  addPivotTables, buildCacheField, cacheDefinitionXml, pivotStartRow, pivotTableXml, withoutFields, xmlText,
} from './xlsxPivots.js';

const COLUMNS = [
  { key: 'owner', label: 'Owner' },
  { key: 'app', label: 'Application' },
  { key: 'direct', label: 'Direct' },
  { key: 'viaRole', label: 'Via role' },
];
const ROWS = [
  { owner: 'Ann', app: 'Payroll', direct: 5, viaRole: 0 },
  { owner: 'bob', app: 'Payroll', direct: 2, viaRole: 7 },
  { owner: 'Bob', app: 'CRM', direct: 40, viaRole: 0 },
  { owner: null, app: 'CRM', direct: 0, viaRole: 3 },
];
const PIVOTS = [
  { name: 'By owner', filters: ['viaRole'], rows: ['owner', 'app'], values: ['direct'] },
  { name: 'Via role', rows: ['app'], values: ['viaRole'] },
];
const REPORT = {
  displayName: 'Pivot Sample', columns: COLUMNS, rows: ROWS, pivots: PIVOTS, total: ROWS.length,
  notices: [{ severity: 'info', text: 'One notice.' }], generatedAt: '2026-09-29T10:00:00.000Z',
};

async function zipOf(report) {
  return JSZip.loadAsync(await EXPORT_FORMATS.xlsx.serialize(report));
}
const part = (zip, path) => zip.file(path)?.async('string');
const attrs = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag} ([^>]*?)/?>`, 'g'))]
  .map(m => Object.fromEntries([...m[1].matchAll(/(\w+(?::\w+)?)="([^"]*)"/g)].map(a => [a[1], a[2]])));

/** Each cache field's items, decoded: numbers as numbers, text as text, blank as null. */
function decodeCache(definition) {
  return [...definition.matchAll(/<cacheField name="([^"]*)"[^>]*><sharedItems([^>]*)>(.*?)<\/sharedItems>/g)]
    .map(([, name, sharedAttrs, body]) => ({
      name,
      sharedAttrs,
      items: [...body.matchAll(/<(s|n|m)(?: v="([^"]*)")?\/>/g)]
        .map(([, t, v]) => (t === 'm' ? null : t === 'n' ? Number(v) : v)),
    }));
}
function decodeRecords(records, fields) {
  return [...records.matchAll(/<r>(.*?)<\/r>/g)].map(([, body]) =>
    [...body.matchAll(/<x v="(\d+)"\/>/g)].map(([, x], i) => fields[i].items[Number(x)]));
}

describe('xlsx pivots — the workbook', () => {
  it('adds one tab per declared pivot, after the data, named as declared', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await EXPORT_FORMATS.xlsx.serialize(REPORT));
    expect(workbook.worksheets.map(s => s.name)).toEqual(['Pivot Sample', 'By owner', 'Via role']);
  });

  it('points the cache at exactly the data table: header row through the last row, every column', async () => {
    const zip = await zipOf(REPORT);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await EXPORT_FORMATS.xlsx.serialize(REPORT));
    let header = 0;
    workbook.worksheets[0].eachRow((row, i) => { if (!header && row.getCell(1).value === 'Owner') header = i; });

    const [source] = attrs(await part(zip, 'xl/pivotCache/pivotCacheDefinition1.xml'), 'worksheetSource');
    expect(source).toEqual({ ref: `A${header}:D${header + ROWS.length}`, sheet: 'Pivot Sample' });
  });

  it('writes a cache that decodes back into the very rows it came from', async () => {
    const zip = await zipOf(REPORT);
    const fields = decodeCache(await part(zip, 'xl/pivotCache/pivotCacheDefinition1.xml'));
    expect(fields.map(f => f.name)).toEqual(['Owner', 'Application', 'Direct', 'Via role']);

    const decoded = decodeRecords(await part(zip, 'xl/pivotCache/pivotCacheRecords1.xml'), fields);
    // 'Bob' folds into 'bob' — Excel's own case-insensitive items — and nothing else moves.
    expect(decoded).toEqual([
      ['Ann', 'Payroll', 5, 0],
      ['bob', 'Payroll', 2, 7],
      ['bob', 'CRM', 40, 0],
      [null, 'CRM', 0, 3],
    ]);
  });

  it('wires every part together: workbook cache list, relationships and content types', async () => {
    const zip = await zipOf(REPORT);
    expect(await part(zip, 'xl/workbook.xml'))
      .toMatch(/<calcPr[^>]*\/><pivotCaches><pivotCache cacheId="1" r:id="rIdPivotCache1"\/><\/pivotCaches>/);
    expect(await part(zip, 'xl/_rels/workbook.xml.rels'))
      .toContain('Id="rIdPivotCache1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"');
    expect(await part(zip, 'xl/worksheets/_rels/sheet2.xml.rels')).toContain('Target="../pivotTables/pivotTable1.xml"');
    expect(await part(zip, 'xl/worksheets/_rels/sheet3.xml.rels')).toContain('Target="../pivotTables/pivotTable2.xml"');
    expect(await part(zip, 'xl/pivotTables/_rels/pivotTable2.xml.rels')).toContain('Target="../pivotCache/pivotCacheDefinition1.xml"');
    expect(await part(zip, 'xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels')).toContain('Target="pivotCacheRecords1.xml"');

    const types = await part(zip, '[Content_Types].xml');
    for (const p of ['/xl/pivotCache/pivotCacheDefinition1.xml', '/xl/pivotCache/pivotCacheRecords1.xml',
      '/xl/pivotTables/pivotTable1.xml', '/xl/pivotTables/pivotTable2.xml']) {
      expect(types).toContain(`PartName="${p}"`);
    }
  });

  it('lays each pivot out as declared: row fields in order, filters, and a summed value', async () => {
    const zip = await zipOf(REPORT);
    const first = await part(zip, 'xl/pivotTables/pivotTable1.xml');
    expect(attrs(first, 'field').map(f => f.x)).toEqual(['0', '1']);
    expect(attrs(first, 'pageField').map(f => f.fld)).toEqual(['3']);
    expect(attrs(first, 'dataField')).toEqual([{ name: 'Sum of Direct', fld: '2', baseField: '0', baseItem: '0' }]);
    expect(attrs(first, 'location')[0].ref).toBe('A3:B4');

    const second = await part(zip, 'xl/pivotTables/pivotTable2.xml');
    expect(attrs(second, 'field').map(f => f.x)).toEqual(['1']);
    expect(second).not.toContain('<pageFields');
    expect(attrs(second, 'dataField')[0].name).toBe('Sum of Via role');
  });

  it('adds no pivot to a report that declares none — the workbook is the plain one', async () => {
    const zip = await zipOf({ ...REPORT, pivots: undefined });
    expect(zip.file('xl/pivotCache/pivotCacheDefinition1.xml')).toBeNull();
    expect(await part(zip, 'xl/workbook.xml')).not.toContain('pivotCaches');
  });

  it('leaves a column the run moved into the header out of the pivot, instead of failing the download', async () => {
    // One application: `app` is stated once above the table and is not a table
    // column, so the pivot cannot name it. Dropping it loses nothing — one value
    // is one item. 'owner' stays, and still leads the rows.
    const oneApp = ROWS.map(r => ({ ...r, app: 'Payroll' }));
    const zip = await zipOf({ ...REPORT, rows: oneApp, constantColumns: ['app'] });
    const fields = decodeCache(await part(zip, 'xl/pivotCache/pivotCacheDefinition1.xml'));
    expect(fields.map(f => f.name)).toEqual(['Owner', 'Direct', 'Via role']);

    const first = await part(zip, 'xl/pivotTables/pivotTable1.xml');
    expect(attrs(first, 'field').map(f => f.x)).toEqual(['0']);
    expect(attrs(first, 'dataField')[0]).toMatchObject({ name: 'Sum of Direct', fld: '1' });
    // The second pivot had only `app` on its rows: it keeps its value, as a grand total.
    const second = await part(zip, 'xl/pivotTables/pivotTable2.xml');
    expect(second).not.toContain('<rowFields');
    expect(attrs(second, 'dataField')[0]).toMatchObject({ name: 'Sum of Via role', fld: '2' });
  });

  it('drops the named keys from every area of a declaration, and leaves the rest alone', () => {
    const pivot = { name: 'P', rows: ['a', 'b'], filters: ['b', 'c'], values: ['b', 'd'] };
    expect(withoutFields(pivot, ['b'])).toEqual({ name: 'P', rows: ['a'], filters: ['c'], values: ['d'] });
    expect(withoutFields({ name: 'Q' }, ['b'])).toEqual({ name: 'Q', rows: [], filters: [], values: [] });
    expect(pivot.rows).toEqual(['a', 'b']);
  });

  it('adds no pivot tab when the report found nothing to pivot', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await EXPORT_FORMATS.xlsx.serialize({ ...REPORT, rows: [], total: 0 }));
    expect(workbook.worksheets.map(s => s.name)).toEqual(['Pivot Sample']);
  });
});

describe('xlsx pivots — cache fields', () => {
  it('treats an all-number column as numeric, with its range', () => {
    const field = buildCacheField({ key: 'n', label: 'N' }, [{ n: 4 }, { n: 1.5 }, { n: 4 }]);
    expect(field.numeric).toBe(true);
    expect(field.items).toEqual([4, 1.5]);
  });

  it('treats a column mixing numbers and text as text, so nothing is summed wrongly', () => {
    const field = buildCacheField({ key: 'n', label: 'N' }, [{ n: 4 }, { n: 'four' }]);
    expect(field.numeric).toBe(false);
    expect(field.items).toEqual(['4', 'four']);
  });

  it('keeps apart numbers that only look alike as text — 1 and "1" differ, 10 and 1 differ', () => {
    const field = buildCacheField({ key: 'n', label: 'N' }, [{ n: 1 }, { n: 10 }, { n: 1 }]);
    expect(field.items).toEqual([1, 10]);
    expect(field.index.get(10)).toBe(1);
  });

  it('writes the attributes Excel expects for numbers, blanks and long text', async () => {
    const zip = await zipOf({
      ...REPORT,
      columns: [...COLUMNS, { key: 'note', label: 'Note' }, { key: 'empty', label: 'Empty' }, { key: 'gap', label: 'Gap' }],
      rows: ROWS.map((r, i) => ({ ...r, note: 'x'.repeat(i ? 10 : 256), empty: null, gap: i ? i : null })),
    });
    const fields = decodeCache(await part(zip, 'xl/pivotCache/pivotCacheDefinition1.xml'));
    const byName = Object.fromEntries(fields.map(f => [f.name, f.sharedAttrs]));
    expect(byName.Direct).toContain('containsSemiMixedTypes="0"');
    expect(byName.Direct).toContain('containsInteger="1" minValue="0" maxValue="40"');
    expect(byName.Owner).toContain('containsBlank="1"');
    expect(byName.Owner).not.toContain('containsNumber');
    expect(byName.Note).toContain('longText="1"');
    expect(byName.Application).not.toContain('longText');
    expect(byName.Empty).toContain('containsString="0" containsBlank="1" count="1"');
    // A number column with a blank is not "never mixed", and still has its range.
    expect(byName.Gap).not.toContain('containsSemiMixedTypes');
    expect(byName.Gap).toContain('containsBlank="1" containsNumber="1" containsInteger="1" minValue="1" maxValue="3"');
  });

  it('leaves out containsInteger when a number column holds fractions', () => {
    const fields = [buildCacheField({ key: 'n', label: 'N' }, [{ n: 1.5 }, { n: 2 }])];
    const xml = cacheDefinitionXml({ sheet: 'S', ref: 'A1:A3', fields, recordCount: 2 });
    expect(xml).toContain('containsNumber="1" minValue="1.5" maxValue="2"');
    expect(xml).not.toContain('containsInteger');
  });
});

describe('xlsx pivots — the pivot table', () => {
  const fields = [
    buildCacheField({ key: 'name', label: 'Name' }, [{ name: 'beta' }, { name: null }, { name: 'Alpha' }, { name: 'gamma' }]),
    buildCacheField({ key: 'n', label: 'N' }, [{ n: 30 }, { n: 4 }, { n: 200 }, { n: 4 }]),
    buildCacheField({ key: 'm', label: 'M' }, [{ m: 1 }, { m: 2 }, { m: 3 }, { m: 4 }]),
  ];

  it('lists a text field\'s items alphabetically, ignoring case, blank last, subtotal after', () => {
    const xml = pivotTableXml(fields, { name: 'p', rows: ['name'], values: ['n'] });
    const items = xml.match(/<pivotField axis="axisRow"[^>]*><items count="5">(.*?)<\/items>/)[1];
    // items were cached as beta(0), blank(1), Alpha(2), gamma(3)
    expect(items).toBe('<item x="2"/><item x="0"/><item x="3"/><item x="1"/><item t="default"/>');
  });

  it('lists a number field\'s items numerically, not as text (4 before 30 before 200)', () => {
    const xml = pivotTableXml(fields, { name: 'p', filters: ['n'], values: ['m'] });
    const items = xml.match(/<pivotField axis="axisPage"[^>]*><items count="4">(.*?)<\/items>/)[1];
    expect(items).toBe('<item x="1"/><item x="0"/><item x="2"/><item t="default"/>');
  });

  it('marks a field that is both a filter and the summed value as both', () => {
    const xml = pivotTableXml(fields, { name: 'p', filters: ['n'], values: ['n'] });
    expect(xml).toContain('<pivotField axis="axisPage" dataField="1" showAll="0">');
  });

  it('puts several values side by side through the synthetic Values field', () => {
    const xml = pivotTableXml(fields, { name: 'p', rows: ['name'], values: ['n', 'm'] });
    expect(xml).toContain('<colFields count="1"><field x="-2"/></colFields>');
    expect(xml).toContain('<colItems count="2"><i><x/></i><i i="1"><x v="1"/></i></colItems>');
    expect(attrs(xml, 'dataField').map(d => d.name)).toEqual(['Sum of N', 'Sum of M']);
  });

  it('refuses a pivot that names a column the report does not have', () => {
    expect(() => pivotTableXml(fields, { name: 'Broken', rows: ['nope'] }))
      .toThrow('Pivot "Broken" names column "nope", which the report does not have');
  });

  it.each([[0, 3], [1, 3], [2, 4], [5, 7]])('starts the table below %i filter(s) at row %i', (filters, row) => {
    expect(pivotStartRow(filters)).toBe(row);
  });
});

describe('xlsx pivots — assembling the zip', () => {
  const source = { sheet: 'Data', ref: 'A1:A2', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x' }] };
  const pivot = { name: 'P', rows: ['a'] };

  async function baseWorkbook(mutate = async () => {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Data');
    workbook.addWorksheet('P');
    const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
    await mutate(zip);
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('returns the workbook untouched when there is nothing to add', async () => {
    const buffer = Buffer.from('not even a zip');
    expect(await addPivotTables(buffer, source, [])).toBe(buffer);
  });

  it('appends the cache list at the end of a workbook part that has no calcPr', async () => {
    const buffer = await baseWorkbook(async (zip) => {
      const xml = await zip.file('xl/workbook.xml').async('string');
      zip.file('xl/workbook.xml', xml.replace(/<calcPr[^>]*\/>/, ''));
    });
    const zip = await JSZip.loadAsync(await addPivotTables(buffer, source, [{ sheetId: 2, pivot }]));
    expect(await part(zip, 'xl/workbook.xml')).toMatch(/<\/sheets><pivotCaches>.*<\/pivotCaches><\/workbook>$/);
  });

  it('adds to a worksheet\'s existing relationships instead of replacing them', async () => {
    const buffer = await baseWorkbook(async (zip) => {
      zip.file('xl/worksheets/_rels/sheet2.xml.rels',
        '<Relationships xmlns="x"><Relationship Id="rIdKeep" Type="t" Target="keep.xml"/></Relationships>');
    });
    const zip = await JSZip.loadAsync(await addPivotTables(buffer, source, [{ sheetId: 2, pivot }]));
    const rels = await part(zip, 'xl/worksheets/_rels/sheet2.xml.rels');
    expect(rels).toContain('Id="rIdKeep"');
    expect(rels).toContain('Target="../pivotTables/pivotTable1.xml"');
  });

  it('fails loudly on a sheet that has no worksheet part', async () => {
    await expect(addPivotTables(await baseWorkbook(), source, [{ sheetId: 9, pivot }]))
      .rejects.toThrow('No worksheet part for sheet 9');
  });

  it('fails loudly on a part that is not shaped the way ExcelJS writes it', async () => {
    const buffer = await baseWorkbook(async (zip) => { zip.file('[Content_Types].xml', '<Types/>'); });
    await expect(addPivotTables(buffer, source, [{ sheetId: 2, pivot }]))
      .rejects.toThrow('Unexpected workbook part: [Content_Types].xml');
  });
});

describe('xmlText', () => {
  it('escapes markup and drops the control characters XML cannot carry', () => {
    expect(xmlText('A & <B> "C"\u0001\u0008\u000B\u001F\tD')).toBe('A &amp; &lt;B&gt; &quot;C&quot;\tD');
  });

  it('writes an escaped name that survives into the cache and the pivot', async () => {
    const zip = await zipOf({
      ...REPORT,
      columns: [{ key: 'owner', label: 'Owner & <Co>' }, ...COLUMNS.slice(1)],
      rows: [{ owner: 'R&D "Lab"', app: 'a', direct: 1, viaRole: 0 }],
    });
    const definition = await part(zip, 'xl/pivotCache/pivotCacheDefinition1.xml');
    expect(definition).toContain('name="Owner &amp; &lt;Co&gt;"');
    expect(definition).toContain('<s v="R&amp;D &quot;Lab&quot;"/>');
  });
});
