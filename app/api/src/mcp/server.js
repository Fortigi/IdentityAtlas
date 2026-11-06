// One MCP server per request (stateless Streamable HTTP): it lists the tools the
// caller may use and runs them on the caller's behalf.
//
// A tool is { name, title, description, inputSchema, permission, owner, run(args, ctx) }.
// `permission` is the same permission the UI and REST API require for that data
// (null = only mcp.use, which mcp/auth.js already checked). A tool the caller
// lacks the permission for is neither listed nor callable.
//
// `owner` says what the tool does for a context owner (mcp/ownerScope.js), and
// every tool MUST say it (tools.guard.test.js): 'scoped' — it runs under the
// owner's scope, enforced in the code it calls; 'refused' — not offered to them.
// A tool added without deciding is not offered to an owner either.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listReports, runReportTool } from './tools/reports.js';
import { describeDataModel, runQuery } from './tools/query.js';
import { search, whoAmI } from './tools/identity.js';
import { getPhotos } from './tools/photos.js';
import { hasPermission } from './auth.js';
import { recordToolCall } from './audit.js';
import { errorResult } from './result.js';

export const TOOLS = [whoAmI, listReports, runReportTool, describeDataModel, runQuery, search, getPhotos];

export const INSTRUCTIONS = `Identity Atlas holds who has access to what across the organisation's systems (Entra ID and others): accounts, the persons behind them, groups, roles, applications, permissions, owners, business roles / access packages, and changes over time.
You act on behalf of the signed-in user and see what their role allows. Everything here is read-only.
- A ready-made report often answers the question best: check list_reports, then run_report.
- For anything else: call describe_data_model once, then run_query with a report definition (JSON, never SQL).
- Use search to turn a name the user mentions into the exact record.
- Results are capped; when "truncated" is true, say the list is partial and give the link.
- Rows carry a "link" to the record in Identity Atlas: include links when you list records.
- Answer in the user's language. Counts with groupBy make good charts.
- For pictures of people (an org chart, a card), get_photos returns their profile photos; use initials for anyone without one.
- Every result carries "scope". When scope.restricted is true the user sees only part of the organisation: say that the numbers and lists cover only what they may see, and never present a count as a total for the whole organisation. "truncated" is something else: the list was cut off at the row cap.`;

// Added for a context owner: who they are acting as, in a sentence.
export const OWNER_INSTRUCTIONS = `
You are acting for a context owner: someone who answers for one or more contexts (a department, a team, an application) without a general Identity Atlas role. They see those contexts, the people in them, what those people hold, and their sub-units — nothing else. Questions about anything outside that come back empty or are refused. When a result says a record "exists … outside the part you may see" (or a search match has "accessible": false), tell them it exists but that you cannot show details — never that it does not exist. Only when nothing was found at all, say it could not be found. Lists of members or holders are complete, as in the app, so they can name people the user cannot open.`;

export function instructionsFor(user) {
  return user?.contextOwner ? `${INSTRUCTIONS}\n${OWNER_INSTRUCTIONS}` : INSTRUCTIONS;
}

export function allowedTools(user, tools = TOOLS) {
  if (user?.contextOwner) return tools.filter(t => t.owner === 'scoped');
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
    { capabilities: { tools: {} }, instructions: instructionsFor(ctx.user) },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allowed.map(describe) }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(allowed, request.params, ctx, audit));
  return mcp;
}
