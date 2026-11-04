// One MCP server per request (stateless Streamable HTTP): it lists the tools the
// caller may use and runs them on the caller's behalf.
//
// A tool is { name, title, description, inputSchema, permission, run(args, ctx) }.
// `permission` is the same permission the UI and REST API require for that data
// (null = only mcp.use, which mcp/auth.js already checked). A tool the caller
// lacks the permission for is neither listed nor callable.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listReports, runReportTool } from './tools/reports.js';
import { describeDataModel, runQuery } from './tools/query.js';
import { search, whoAmI } from './tools/identity.js';
import { hasPermission } from './auth.js';
import { recordToolCall } from './audit.js';
import { errorResult } from './result.js';

export const TOOLS = [whoAmI, listReports, runReportTool, describeDataModel, runQuery, search];

export const INSTRUCTIONS = `Identity Atlas holds who has access to what across the organisation's systems (Entra ID and others): accounts, the persons behind them, groups, roles, applications, permissions, owners, business roles / access packages, and changes over time.
You act on behalf of the signed-in user and see what their role allows. Everything here is read-only.
- A ready-made report often answers the question best: check list_reports, then run_report.
- For anything else: call describe_data_model once, then run_query with a report definition (JSON, never SQL).
- Use search to turn a name the user mentions into the exact record.
- Results are capped; when "truncated" is true, say the list is partial and give the link.
- Rows carry a "link" to the record in Identity Atlas: include links when you list records.
- Answer in the user's language. Counts with groupBy make good charts.`;

export function allowedTools(user, tools = TOOLS) {
  const perms = user?.permissions || new Set();
  return tools.filter(t => !t.permission || hasPermission(perms, t.permission));
}

function describe(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

export async function callTool(tools, params, ctx, audit = recordToolCall) {
  const tool = tools.find(t => t.name === params?.name);
  const started = Date.now();
  const entry = {
    userOid: ctx.user?.oid, userName: ctx.user?.preferred_username || ctx.user?.upn || ctx.user?.name,
    client: ctx.client, tool: params?.name, arguments: params?.arguments ?? null,
  };
  if (!tool) {
    await audit({ ...entry, outcome: 'refused', error: 'unknown or not permitted tool' });
    return errorResult('Unknown tool, or your role does not allow it.');
  }
  try {
    const { rowCount, ...result } = await tool.run(params.arguments || {}, ctx);
    await audit({ ...entry, outcome: result.isError ? 'invalid' : 'ok', rowCount, durationMs: Date.now() - started });
    return result;
  } catch (err) {
    console.error(`MCP tool ${tool.name} failed:`, err.message);
    await audit({ ...entry, outcome: 'failed', error: err.message, durationMs: Date.now() - started });
    return errorResult('The tool failed on the server. Try again, or simplify the request.');
  }
}

export function createMcpServer(ctx, { version = '0.0.0', tools = TOOLS, audit = recordToolCall } = {}) {
  const allowed = allowedTools(ctx.user, tools);
  const mcp = new McpServer(
    { name: 'identity-atlas', title: 'Identity Atlas', version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allowed.map(describe) }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(allowed, request.params, ctx, audit));
  return mcp;
}
