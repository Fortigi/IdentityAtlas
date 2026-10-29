// Run one report template and build the payload every consumer reads: the
// Reports screen (/api/reports/:name/rows), the download (…/export) and the MCP
// server's run_report tool. One function, so a download or an AI assistant can
// never get something the screen would not show.
//
// `notices` is whatever the template returned, passed through untouched: the
// engine never reads a notice, exactly as it never reads a row.
//
// `columns` and `pivots` are the template's declaration unless the run returned
// its own: a report whose columns are picked by the reader (a parameter) only
// knows them once it has run. The screen, the CSV and the workbook all read the
// payload, so they follow the run either way.

import { reportMetadata } from './registry.js';

export async function runReport(report, params) {
  const { rows, notices, truncated, constantColumns, columns, pivots } = await report.run(params, {});
  const metadata = reportMetadata(report);
  return {
    ...metadata,
    columns: Array.isArray(columns) ? columns : metadata.columns,
    pivots: Array.isArray(pivots) ? pivots : metadata.pivots,
    rows,
    notices: Array.isArray(notices) ? notices : [],
    // Column keys THIS run holds one value for. `columns` above is the report's
    // and does not change: the screen shows every column whatever the run said,
    // and only a format with room for a header acts on this.
    constantColumns: Array.isArray(constantColumns) ? constantColumns : [],
    total: rows.length,
    // A template that stops at a row cap says so; the screen and the download must
    // not present the first N rows as the whole answer.
    truncated: truncated === true,
    generatedAt: new Date().toISOString(),
  };
}
