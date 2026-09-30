// Pivot tables inside an exported workbook.
//
// A report can declare pivots — which columns go on the rows, in the filters and
// in the values — and the xlsx download then opens with each one ready on its
// own tab, instead of the reader building the same pivot by hand every time.
// Like everything else in the export, this is keyed on the declaration and never
// on a report name.
//
// ExcelJS (4.4, the released line) writes no pivot tables, so they are added to
// the zip after ExcelJS has written it: one pivot cache over the data table,
// shared by every pivot, and one pivot table part per pivot sheet. The cache is
// marked `refreshOnLoad`, so Excel recomputes the layout from the sheet when the
// file opens — which is why the row/column item blocks written here are only the
// minimal placeholders the schema requires, not a pre-rendered pivot.
//
// Excel treats pivot items case-insensitively ("Quarterly" and "quarterly" are
// one item), so the cache folds them the same way; writing both as separate
// items would be a cache Excel itself never produces.

import JSZip from 'jszip';

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const CACHE_ID = 1;
// Excel's own limit for a pivot item; a longer string must be flagged on the cache field.
const SHORT_TEXT = 255;
const BLANK = Symbol('blank');

/** Text safe inside an XML attribute: escaped, and without the control characters XML 1.0 forbids. */
export function xmlText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const isBlank = v => v === null || v === undefined || v === '';

/** The key a value is folded to: numbers as themselves, text case-insensitively. */
function itemKey(value, numeric) {
  if (isBlank(value)) return BLANK;
  return numeric ? value : String(value).toLowerCase();
}

/**
 * One cache field per column: its distinct values (the pivot's items), and an
 * index from each value to its item. A column is numeric only when every value
 * in it is a number — a count column then sums, and a mixed column is text.
 */
export function buildCacheField(column, rows) {
  const values = rows.map(r => r[column.key]);
  const numeric = values.some(v => !isBlank(v)) && values.every(v => isBlank(v) || Number.isFinite(v));
  const items = [];
  const index = new Map();
  for (const value of values) {
    const key = itemKey(value, numeric);
    if (index.has(key)) continue;
    index.set(key, items.length);
    items.push(key === BLANK ? BLANK : (numeric ? value : String(value)));
  }
  return { name: String(column.label ?? column.key), key: column.key, numeric, items, index };
}

function sharedItemsXml(field) {
  const hasBlank = field.items.includes(BLANK);
  const present = field.items.filter(i => i !== BLANK);
  const attrs = [];
  if (field.numeric) {
    if (!hasBlank) attrs.push('containsSemiMixedTypes="0"');
    attrs.push('containsString="0"');
    if (hasBlank) attrs.push('containsBlank="1"');
    attrs.push('containsNumber="1"');
    if (present.every(Number.isInteger)) attrs.push('containsInteger="1"');
    // A loop, not Math.min(...present): a 50,000-row column overruns the argument limit.
    const min = present.reduce((a, b) => (b < a ? b : a));
    const max = present.reduce((a, b) => (b > a ? b : a));
    attrs.push(`minValue="${min}" maxValue="${max}"`);
  } else {
    if (!present.length) attrs.push('containsString="0"');
    if (hasBlank) attrs.push('containsBlank="1"');
    if (present.some(s => s.length > SHORT_TEXT)) attrs.push('longText="1"');
  }
  attrs.push(`count="${field.items.length}"`);
  const items = field.items.map((item) => {
    if (item === BLANK) return '<m/>';
    return field.numeric ? `<n v="${item}"/>` : `<s v="${xmlText(item)}"/>`;
  });
  return `<sharedItems ${attrs.join(' ')}>${items.join('')}</sharedItems>`;
}

/** The pivot cache definition: where the data lives and every column's items. */
export function cacheDefinitionXml({ sheet, ref, fields, recordCount }) {
  const cacheFields = fields
    .map(f => `<cacheField name="${xmlText(f.name)}" numFmtId="0">${sharedItemsXml(f)}</cacheField>`)
    .join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<pivotCacheDefinition xmlns="${NS_MAIN}" xmlns:r="${NS_REL}" r:id="rId1" refreshOnLoad="1"`
    + ` createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="${recordCount}">`
    + `<cacheSource type="worksheet"><worksheetSource ref="${ref}" sheet="${xmlText(sheet)}"/></cacheSource>`
    + `<cacheFields count="${fields.length}">${cacheFields}</cacheFields>`
    + '</pivotCacheDefinition>';
}

/** One record per data row, each value written as its item index. */
export function cacheRecordsXml(fields, rows) {
  const records = rows.map((row) => {
    const cells = fields.map(f => `<x v="${f.index.get(itemKey(row[f.key], f.numeric))}"/>`);
    return `<r>${cells.join('')}</r>`;
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<pivotCacheRecords xmlns="${NS_MAIN}" xmlns:r="${NS_REL}" count="${rows.length}">${records.join('')}</pivotCacheRecords>`;
}

/**
 * A field's items in the order the pivot lists them: ascending, blanks last —
 * the order a pivot built by hand shows. The trailing default item is the
 * subtotal Excel adds to every row and filter field.
 */
function fieldItemsXml(field) {
  const order = field.items.map((item, x) => ({ item, x })).sort((a, b) => {
    if (a.item === BLANK || b.item === BLANK) return (a.item === BLANK) - (b.item === BLANK);
    return field.numeric ? a.item - b.item : a.item.localeCompare(b.item, 'en', { sensitivity: 'base' });
  });
  const items = order.map(({ x }) => `<item x="${x}"/>`).join('');
  return `<items count="${order.length + 1}">${items}<item t="default"/></items>`;
}

/** The field indexes a pivot declaration names, failing loudly on a key that is not a column. */
function fieldIndexes(fields, keys = [], pivotName) {
  return keys.map((key) => {
    const i = fields.findIndex(f => f.key === key);
    if (i < 0) throw new Error(`Pivot "${pivotName}" names column "${key}", which the report does not have`);
    return i;
  });
}

function pivotFieldXml(field, i, { rows, filters, values }) {
  const axis = rows.includes(i) ? 'axisRow' : (filters.includes(i) ? 'axisPage' : null);
  const data = values.includes(i) ? ' dataField="1"' : '';
  if (!axis) return `<pivotField${data} showAll="0"/>`;
  return `<pivotField axis="${axis}"${data} showAll="0">${fieldItemsXml(field)}</pivotField>`;
}

/**
 * The layout block of a pivot table. Excel re-renders it on open (the cache is
 * refreshOnLoad), so the item lists are the schema's minimal placeholders.
 * Several values need the synthetic "Values" field (-2) across the columns.
 */
function layoutXml(fields, used) {
  const parts = [];
  if (used.rows.length) {
    parts.push(`<rowFields count="${used.rows.length}">${used.rows.map(x => `<field x="${x}"/>`).join('')}</rowFields>`);
    parts.push('<rowItems count="1"><i t="grand"><x/></i></rowItems>');
  }
  if (used.values.length > 1) {
    parts.push('<colFields count="1"><field x="-2"/></colFields>');
    const cols = used.values.map((_, i) => (i === 0 ? '<i><x/></i>' : `<i i="${i}"><x v="${i}"/></i>`));
    parts.push(`<colItems count="${cols.length}">${cols.join('')}</colItems>`);
  } else {
    parts.push('<colItems count="1"><i/></colItems>');
  }
  if (used.filters.length) {
    parts.push(`<pageFields count="${used.filters.length}">${used.filters.map(x => `<pageField fld="${x}" hier="-1"/>`).join('')}</pageFields>`);
  }
  if (used.values.length) {
    const data = used.values.map(x => `<dataField name="${xmlText(`Sum of ${fields[x].name}`)}" fld="${x}" baseField="0" baseItem="0"/>`);
    parts.push(`<dataFields count="${data.length}">${data.join('')}</dataFields>`);
  }
  return parts.join('');
}

/**
 * The first row of the pivot on its sheet. Filters sit above it, one per row,
 * with a blank row between them and the table — where Excel places a pivot it
 * creates on a new sheet (A3, pushed down when the filters need the room).
 */
export function pivotStartRow(filterCount) {
  return Math.max(3, filterCount + 2);
}

/** One pivot table definition over the shared cache. */
export function pivotTableXml(fields, pivot) {
  const used = {
    rows: fieldIndexes(fields, pivot.rows, pivot.name),
    filters: fieldIndexes(fields, pivot.filters, pivot.name),
    values: fieldIndexes(fields, pivot.values, pivot.name),
  };
  const top = pivotStartRow(used.filters.length);
  const pageCounts = used.filters.length ? ` rowPageCount="${used.filters.length}" colPageCount="1"` : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<pivotTableDefinition xmlns="${NS_MAIN}" name="PivotTable1" cacheId="${CACHE_ID}"`
    + ' applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0"'
    + ' applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="6"'
    + ' minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" indent="0"'
    + ' outline="1" outlineData="1" multipleFieldFilters="0">'
    + `<location ref="A${top}:B${top + 1}" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"${pageCounts}/>`
    + `<pivotFields count="${fields.length}">${fields.map((f, i) => pivotFieldXml(f, i, used)).join('')}</pivotFields>`
    + layoutXml(fields, used)
    + '<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1"'
    + ' showRowStripes="0" showColStripes="0" showLastColumn="1"/>'
    + '</pivotTableDefinition>';
}

const relationship = (id, type, target) => `<Relationship Id="${id}" Type="${NS_REL}/${type}" Target="${target}"/>`;
const relationships = body => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS_PKG_REL}">${body}</Relationships>`;
const override = (part, type) => `<Override PartName="${part}" ContentType="${CONTENT_TYPE}.${type}+xml"/>`;

/** Insert `xml` before the closing tag of a part, failing if the part is not what ExcelJS writes. */
async function insertBefore(zip, path, closingTag, xml) {
  const text = await zip.file(path)?.async('string');
  if (!text?.includes(closingTag)) throw new Error(`Unexpected workbook part: ${path}`);
  zip.file(path, text.replace(closingTag, `${xml}${closingTag}`));
}

/** The workbook's list of pivot caches, which CT_Workbook places right after calcPr. */
async function registerCache(zip) {
  const path = 'xl/workbook.xml';
  const text = await zip.file(path).async('string');
  const caches = `<pivotCaches><pivotCache cacheId="${CACHE_ID}" r:id="rIdPivotCache1"/></pivotCaches>`;
  const anchored = /<calcPr[^>]*\/>/.test(text)
    ? text.replace(/(<calcPr[^>]*\/>)/, `$1${caches}`)
    : text.replace('</workbook>', `${caches}</workbook>`);
  zip.file(path, anchored);
  await insertBefore(zip, 'xl/_rels/workbook.xml.rels', '</Relationships>',
    relationship('rIdPivotCache1', 'pivotCacheDefinition', 'pivotCache/pivotCacheDefinition1.xml'));
}

/** Attach pivot table `n` to the worksheet file ExcelJS wrote for `sheetId`. */
async function attachPivot(zip, sheetId, n) {
  if (!zip.file(`xl/worksheets/sheet${sheetId}.xml`)) throw new Error(`No worksheet part for sheet ${sheetId}`);
  const relsPath = `xl/worksheets/_rels/sheet${sheetId}.xml.rels`;
  const rel = relationship(`rIdPivot${n}`, 'pivotTable', `../pivotTables/pivotTable${n}.xml`);
  if (zip.file(relsPath)) await insertBefore(zip, relsPath, '</Relationships>', rel);
  else zip.file(relsPath, relationships(rel));
}

/**
 * Add the declared pivots to a workbook ExcelJS has already written.
 *
 * @param {Buffer} buffer        the .xlsx bytes
 * @param {Object} source        the data table: `sheet` name, A1 `ref` of header + rows, `columns`, `rows`
 * @param {Object[]} pivots      one `{ sheetId, pivot }` per pivot sheet, where
 *                               `pivot` is `{ name, rows, filters, values }` in column keys
 * @returns {Promise<Buffer>}
 */
export async function addPivotTables(buffer, source, pivots) {
  if (!pivots.length) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const fields = source.columns.map(column => buildCacheField(column, source.rows));

  zip.file('xl/pivotCache/pivotCacheDefinition1.xml',
    cacheDefinitionXml({ sheet: source.sheet, ref: source.ref, fields, recordCount: source.rows.length }));
  zip.file('xl/pivotCache/pivotCacheRecords1.xml', cacheRecordsXml(fields, source.rows));
  zip.file('xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels',
    relationships(relationship('rId1', 'pivotCacheRecords', 'pivotCacheRecords1.xml')));
  await registerCache(zip);

  const types = [
    override('/xl/pivotCache/pivotCacheDefinition1.xml', 'pivotCacheDefinition'),
    override('/xl/pivotCache/pivotCacheRecords1.xml', 'pivotCacheRecords'),
  ];
  for (const [i, { sheetId, pivot }] of pivots.entries()) {
    const n = i + 1;
    zip.file(`xl/pivotTables/pivotTable${n}.xml`, pivotTableXml(fields, pivot));
    zip.file(`xl/pivotTables/_rels/pivotTable${n}.xml.rels`,
      relationships(relationship('rId1', 'pivotCacheDefinition', '../pivotCache/pivotCacheDefinition1.xml')));
    await attachPivot(zip, sheetId, n);
    types.push(override(`/xl/pivotTables/pivotTable${n}.xml`, 'pivotTable'));
  }
  await insertBefore(zip, '[Content_Types].xml', '</Types>', types.join(''));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
