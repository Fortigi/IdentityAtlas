// MCP tools over the custom-report engine: the assistant writes a report
// DEFINITION (never SQL) and the server validates it against the catalog,
// compiles it to parameterised SQL and runs it read-only with a statement
// timeout (nlreports/service.js runSpec). The same path the Ask page and the
// report builder use — here the AI assistant plays the part of the local model.
//
// Permission: `data.read.reports` ("Ask questions in plain language"), the same
// one the Ask page needs. The customReports feature flag is NOT required: that
// flag governs the builder UI and the local model, neither of which MCP uses.

import { buildSystemPrompt, buildValuesBlock } from '../../nlreports/prompt.js';
import { loadValues, runSpec } from '../../nlreports/service.js';
import { loadExtFields } from '../../nlreports/extFields.js';
import { callerSubstitutions, resolveCaller, ME } from '../../nlreports/caller.js';
import { errorResult, rowLimit, tableResult, MAX_ROWS, DEFAULT_ROWS } from '../result.js';

const PREFACE = `How to use this with Identity Atlas over MCP:
- Below is the reference the built-in report model works from: entities, fields, relations, rules and worked examples.
- You write the definition yourself and pass ONLY the "spec" object (the part after "spec":) to run_query as \`definition\`.
- Where the reference says to reply with {"kind":"clarify"} or {"kind":"decline"}, ask the user yourself or explain instead — never send those to run_query.
- "${ME}" is a value that stands for the signed-in user's own account ("my groups" = group with members some id eq "${ME}").
- The "in" operator also works here, with a list of values (up to 500), e.g. ids returned by an earlier query.
- For a chart or breakdown, use "groupBy" (one row per value with a count) rather than fetching every record.
- When run_query answers with "Did you mean", pick the right record (or ask the user) and run again using its exact name or id.`;

export function attributesBlock(extFields) {
  const lines = [];
  for (const [entity, fields] of Object.entries(extFields || {})) {
    const keys = Object.entries(fields).map(([key, f]) => `${key} (${f.label}, ${f.type})`);
    if (keys.length) lines.push(`- ${entity}: ${keys.join('; ')}`);
  }
  return lines.length
    ? `Attributes from this deployment's own data (use the "ext." field names exactly as written):\n${lines.join('\n')}`
    : '';
}

export const describeDataModel = {
  name: 'describe_data_model',
  title: 'Describe the data model',
  description:
    'Get the reference for writing a run_query definition: the entities (users, persons, groups, resources, '
    + 'accounts, changes, contexts), their fields and relations, the values that exist in this deployment, rules '
    + 'and worked examples. Call this once before your first run_query.',
  permission: 'data.read.reports',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run() {
    const [values, extFields] = await Promise.all([loadValues(), loadExtFields()]);
    const guide = [PREFACE, buildSystemPrompt(), buildValuesBlock(values), attributesBlock(extFields)]
      .filter(Boolean).join('\n\n');
    return { content: [{ type: 'text', text: guide }], rowCount: null };
  },
};

export const runQuery = {
  name: 'run_query',
  title: 'Answer a question with a query',
  description:
    'Answer a question about accounts, persons, groups, roles, applications, access, owners or changes by running '
    + 'a report definition (see describe_data_model for the format — it is JSON, never SQL). Read-only. Returns '
    + `the rows (capped at maxRows, default ${DEFAULT_ROWS}, max ${MAX_ROWS}), the columns, a plain-language `
    + 'explanation of what was run, and "truncated": true when there are more rows.',
  permission: 'data.read.reports',
  inputSchema: {
    type: 'object',
    properties: {
      definition: {
        type: 'object',
        description: 'The report definition: { entity, match, conditions, columns, groupBy?, sort? }.',
        additionalProperties: true,
      },
      maxRows: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
    },
    required: ['definition'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const definition = args?.definition;
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      return errorResult('definition must be an object; call describe_data_model for the format.');
    }
    const limit = rowLimit(args.maxRows);
    const caller = await ctx.caller();
    // Ask for one row more than we show, so a cut-off answer is reported as one.
    const result = await runSpec({ ...definition, limit: limit + 1 }, callerSubstitutions(caller));
    if (!result.ok) {
      return errorResult(result.confirm ? 'Did you mean one of these?' : 'The definition is not valid.', {
        errors: result.errors,
        choices: result.confirm?.choices,
      });
    }
    return tableResult({
      explanation: result.explanation,
      columns: result.columns,
      rows: result.rows,
      limit,
      baseUrl: ctx.baseUrl,
    });
  },
};

// Resolved once per request, and only when a tool needs it.
export function lazyCaller(oid, resolve = resolveCaller) {
  let promise;
  return () => {
    if (!promise) promise = oid ? resolve(oid).catch(() => null) : Promise.resolve(null);
    return promise;
  };
}
