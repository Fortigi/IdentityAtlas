// MCP tools over the report registry: the same built-in and saved reports the
// Reports page lists, run with the same engine (reports/run.js). Reading a report
// needs `data.read`, exactly as GET /api/reports/:name/rows does.

import { listAllReports, reportMetadata, resolveReport } from '../../reports/registry.js';
import { runReport } from '../../reports/run.js';
import { errorResult, jsonResult, rowLimit, tableResult, MAX_ROWS, DEFAULT_ROWS } from '../result.js';

// Report parameters normally arrive as a query string, so templates read strings
// (and lists of strings). An assistant sends JSON: booleans and numbers become
// the strings a query string would have carried; lists stay lists.
export function asQueryParams(parameters) {
  const out = {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return out;
  for (const [k, v] of Object.entries(parameters)) {
    if (v == null) continue;
    out[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return out;
}

export const listReports = {
  name: 'list_reports',
  title: 'List reports',
  description:
    'List the ready-made reports in Identity Atlas (built-in and saved by analysts): name, description, '
    + 'the parameters each accepts and its columns. Use run_report to run one. Prefer a ready-made report '
    + 'when one answers the question — they encode expert judgement (e.g. what counts as high-risk).',
  permission: 'data.read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run() {
    const reports = (await listAllReports()).map(reportMetadata).map(r => ({
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      parameters: r.parametersSchema,
      columns: r.columns.map(c => c.label),
      source: r.source,
    }));
    return jsonResult({ reports }, reports.length);
  },
};

export const runReportTool = {
  name: 'run_report',
  title: 'Run a report',
  description:
    'Run one report from list_reports and return its rows (live data). Pass the report `name` and, '
    + 'optionally, `parameters` as described by that report. Results are capped at maxRows '
    + `(default ${DEFAULT_ROWS}, max ${MAX_ROWS}); "truncated": true means there are more rows — say so, `
    + 'and point the user at the report link for the full list.',
  permission: 'data.read',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The report name from list_reports (not the display name).' },
      parameters: { type: 'object', description: 'Report parameters, as described by the report.', additionalProperties: true },
      maxRows: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const report = await resolveReport(String(args?.name || ''));
    if (!report) return errorResult('No report with that name. Call list_reports for the names.');
    const result = await runReport(report, asQueryParams(args.parameters));
    return tableResult({
      report: result.displayName,
      description: result.description,
      notices: result.notices.map(n => n.text),
      columns: result.columns,
      total: result.total,
      truncated: result.truncated,
      rows: result.rows,
      limit: rowLimit(args.maxRows),
      baseUrl: ctx.baseUrl,
      reportLink: `${ctx.baseUrl}/#reports`,
    });
  },
};
