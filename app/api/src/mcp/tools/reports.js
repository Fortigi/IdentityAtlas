// MCP tools over the report registry: the same built-in and saved reports the
// Reports page lists, run with the same engine (reports/run.js). Reading a report
// needs `data.read`, exactly as GET /api/reports/:name/rows does.
//
// A context owner (mcp/ownerScope.js) may run exactly the reports the REST API
// lets them download — the Actions cards' reports on their own contexts — and
// only with parameters it would accept. The decision is the REST allow-list's
// own (auth/contextOwnerScope.js contextOwnerVerdict, settled by
// middleware/contextOwnerMode.js settleOwnerVerdict), asked about the report's
// download path; nothing here re-states its rules. A report saved by an analyst
// is never one of them.

import { listAllReports, reportMetadata, resolveReport } from '../../reports/registry.js';
import { runReport } from '../../reports/run.js';
import { REPORT_EXPORTS, contextOwnerVerdict } from '../../auth/contextOwnerScope.js';
import { settleOwnerVerdict } from '../../middleware/contextOwnerMode.js';
import { errorResult, jsonResult, rowLimit, tableResult, MAX_ROWS, DEFAULT_ROWS } from '../result.js';
import { scopeOf } from '../ownerScope.js';

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

const exportPath = (name) => `/api/reports/${String(name).toLowerCase()}/export`;

// The report names a context owner's download allow-list holds.
export const OWNER_REPORT_NAMES = Object.freeze([...REPORT_EXPORTS.keys()]
  .map(path => /^\/api\/reports\/([^/]+)\/export$/.exec(path)?.[1])
  .filter(Boolean));

export const OWNER_REPORT_NOTE =
  'You can run these reports on your own contexts only: pass "contexts" with the id of one of the contexts listed in '
  + '"scope" (a name is not accepted). The unit report also takes "includeSubUnits".';

/** May this context owner run `report` with `params`? The REST download's own verdict. */
export async function ownerMayRun(report, params, owner) {
  const verdict = contextOwnerVerdict({ method: 'GET', path: exportPath(report.name), query: params }, owner.contextIds);
  return settleOwnerVerdict(verdict, owner, { body: {} });
}

export const listReports = {
  name: 'list_reports',
  title: 'List reports',
  description:
    'List the ready-made reports in Identity Atlas (built-in and saved by analysts): name, description, '
    + 'the parameters each accepts and its columns. Use run_report to run one. Prefer a ready-made report '
    + 'when one answers the question — they encode expert judgement (e.g. what counts as high-risk).',
  permission: 'data.read',
  // Scoped: a context owner is shown only the reports they may run.
  owner: 'scoped',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, ctx) {
    const owner = ctx?.user?.contextOwner;
    const all = (await listAllReports()).map(reportMetadata);
    const visible = owner ? all.filter(r => OWNER_REPORT_NAMES.includes(r.name)) : all;
    const reports = visible.map(r => ({
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      parameters: r.parametersSchema,
      columns: r.columns.map(c => c.label),
      source: r.source,
    }));
    return jsonResult({ scope: scopeOf(ctx), ...(owner ? { note: OWNER_REPORT_NOTE } : {}), reports }, reports.length);
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
  // Scoped: for a context owner the REST download allow-list decides first.
  owner: 'scoped',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The report name from list_reports (not the display name).' },
      parameters: { type: 'object', description: 'Report parameters, as described by that report.', additionalProperties: true },
      maxRows: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const owner = ctx?.user?.contextOwner;
    const report = await resolveReport(String(args?.name || ''));
    // For a context owner a report outside their list answers exactly like one
    // that does not exist: probing names must not reveal what analysts saved.
    if (!report || (owner && !OWNER_REPORT_NAMES.includes(report.name))) {
      return errorResult('No report with that name. Call list_reports for the names.');
    }
    const params = asQueryParams(args.parameters);
    if (owner && !(await ownerMayRun(report, params, owner))) {
      return errorResult(`This report cannot be run with these parameters within your scope. ${OWNER_REPORT_NOTE}`);
    }
    const result = await runReport(report, params);
    return tableResult({
      scope: scopeOf(ctx),
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
