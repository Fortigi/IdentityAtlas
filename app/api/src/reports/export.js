// Download formats for a computed report.
//
// Keyed on the format name, never on a report name — the same seam as the UI's
// form-renderer map, so every registered template is downloadable the moment it
// exists and a new format is one entry here plus its serializer.
//
// The serializers take exactly the payload the rows endpoint returns, so a
// downloaded file can never disagree with what the screen showed: same columns,
// same rows, same `generatedAt`.

const FILENAME_PREFIX = 'identity-atlas';

// Excel/CSV formula-injection guard (security finding M-05, the same rule the
// UI applies in utils/excelHelpers.js). Report rows carry crawled display names
// and descriptions, so a cell starting with = + - @ (or a leading tab/CR) would
// be executed as a formula when the file is opened in a spreadsheet app. A
// leading apostrophe forces the text to stay text.
function safeCell(text) {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

// One RFC-4180 field: always quoted, embedded quotes doubled. null/undefined
// become an empty field rather than the strings "null"/"undefined".
function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${safeCell(text).replace(/"/g, '""')}"`;
}

// Column labels as the header row, then one line per row, read through the
// report's own column keys — the file has the same shape as the table.
function toCsv({ columns = [], rows = [] }) {
  const lines = [columns.map(col => csvField(col.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(col => csvField(row[col.key])).join(','));
  }
  return lines.join('\r\n');
}

// The whole payload, metadata included — the machine-readable counterpart to
// the CSV, for feeding a report into another tool.
function toJson(report) {
  return JSON.stringify(report, null, 2);
}

export const EXPORT_FORMATS = {
  csv: { extension: 'csv', contentType: 'text/csv; charset=utf-8', serialize: toCsv },
  json: { extension: 'json', contentType: 'application/json; charset=utf-8', serialize: toJson },
};

/** Format names offered for download, in the order the UI should show them. */
export const EXPORT_FORMAT_NAMES = Object.keys(EXPORT_FORMATS);

/**
 * The format a `?format=` query parameter names, or null when it isn't one we
 * offer. `Object.hasOwn` so a request can never dispatch on an inherited
 * Object.prototype member (`constructor`, `toString`, …).
 */
export function resolveExportFormat(format) {
  return Object.hasOwn(EXPORT_FORMATS, format) ? EXPORT_FORMATS[format] : null;
}

/**
 * The filename offered to the browser: product, report and the day the content
 * was computed, so a folder of downloads stays self-describing. The report name
 * is slugged rather than trusted verbatim — it ends up inside a quoted
 * Content-Disposition header.
 */
export function exportFilename(reportName, extension, generatedAt) {
  const slug = String(reportName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'report';
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(generatedAt ?? ''))?.[0];
  return `${FILENAME_PREFIX}-${slug}${day ? `-${day}` : ''}.${extension}`;
}
