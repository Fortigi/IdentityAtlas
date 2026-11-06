// MCP tools over the custom-report engine: the assistant writes a report
// DEFINITION (never SQL) and the server validates it against the catalog,
// compiles it to parameterised SQL and runs it read-only with a statement
// timeout (nlreports/service.js runSpec). The same path the Ask page and the
// report builder use — here the AI assistant plays the part of the local model.
//
// Permission: `data.read.reports` ("Ask questions in plain language"), the same
// one the Ask page needs. The customReports feature flag is NOT required: that
// flag governs the builder UI and the local model, neither of which MCP uses.

import { buildSystemPrompt, buildValuesBlock, describeEntity } from '../../nlreports/prompt.js';
import { loadValues, runSpec } from '../../nlreports/service.js';
import { loadExtFields } from '../../nlreports/extFields.js';
import { ENTITIES } from '../../nlreports/catalog.js';
import { MAX_LIMIT } from '../../nlreports/spec.js';
import { callerSubstitutions, resolveCaller, ME } from '../../nlreports/caller.js';
import { errorResult, rowLimit, tableResult, MAX_ROWS, DEFAULT_ROWS } from '../result.js';
import { OWNER_SCOPE_DESCRIPTION, rowScopeOf, scopeOf } from '../ownerScope.js';

// Prepended to the reference for a context owner, so the assistant reads every
// answer in the right frame before it writes its first query.
export const OWNER_PREFACE = `Your scope: ${OWNER_SCOPE_DESCRIPTION} Every run_query answer is limited to it — `
  + 'a related record (a member, a group, an owner) is shown only when it lies inside it too. Comparing with a reference '
  + 'record ("compare") is not available in this scope.';

// What an assistant needs on top of the reference the local model works from.
// Each line answers a mistake seen when Claude was evaluated on the Ask question
// sets through this server (tools/nl-reports/*.json).
const PREFACE = `How to use this with Identity Atlas over MCP:
- Below is the reference the built-in report model works from: entities, fields, relations, rules and worked examples.
- You write the definition yourself and pass ONLY the "spec" object (the part after "spec":) to run_query as \`definition\`.
- Where the reference says to reply with {"kind":"clarify"} or {"kind":"decline"}, ask the user yourself or explain instead — never send those to run_query.
- "${ME}" is a value that stands for the signed-in user's own account ("my groups" = group with members some id eq "${ME}").
- The "in" operator also works here, with a list of values (up to 500), e.g. the "id" of each row an earlier query returned.
- A relation condition cannot contain another relation. For "the members of the groups X owns" or "the groups of X's reports", run two queries: first fetch the ids, then filter on them with "in".
- "Accounts" without saying users ("all disabled accounts") means the account entity: users AND service principals and managed identities. Use user only when people or users are meant.
- An "empty" group, or a group "without members", is FULLY empty by default: memberCount eq 0 AND eligibleMembers none. "members none" only means no accounts — such a group can still hold devices or nested groups. Answer the fully empty reading; if members none finds more, say how many hold only devices or nested groups and offer to list them.
- Sorting is an object: "sort": {"field": "memberCount", "direction": "desc"}.
- When run_query says "truncated": true, "total" (or "totalAtLeast") is the full count: give the user that number, never present the rows shown as all of them.
- For a chart or breakdown, use "groupBy" (one row per value with a count) rather than fetching every record.
- When run_query answers with "Did you mean", pick the right record (or ask the user) and run again using its exact name or id.`;

// Contexts are kept out of the local model's prompt (catalog.js, modelFacing),
// but run_query handles them, and an assistant has the room to be told about them.
export function contextBlock() {
  return `# Contexts (also an entity for run_query)\n${describeEntity('context', ENTITIES.context)}`;
}

/** The deployment's own attributes, for the entities asked for. */
export function attributesBlock(extFields, entities) {
  const lines = [];
  for (const [entity, fields] of Object.entries(extFields || {})) {
    if (entities && !entities.includes(entity)) continue;
    const keys = Object.entries(fields).map(([key, f]) => `${key} (${f.label}, ${f.type})`);
    if (keys.length) lines.push(`- ${entity}: ${keys.join('; ')}`);
  }
  return lines.length
    ? `Attributes from this deployment's own data (use the "ext." field names exactly as written):\n${lines.join('\n')}`
    : '';
}

// The attribute lists are long (a few hundred names) and most questions need
// none of them, so the reference only says they exist and how to get them.
export function attributesSummary(extFields) {
  const counts = Object.entries(extFields || {})
    .map(([entity, fields]) => [entity, Object.keys(fields).length])
    .filter(([, n]) => n > 0);
  if (!counts.length) return '';
  return `This deployment also has its own attributes ("ext." fields): ${counts.map(([e, n]) => `${e} ${n}`).join(', ')}. `
    + 'To list them, call describe_data_model with {"attributes": ["<entity>"]}.';
}

export const describeDataModel = {
  name: 'describe_data_model',
  title: 'Describe the data model',
  description:
    'Get the reference for writing a run_query definition: the entities (users, persons, groups, resources, '
    + 'accounts, changes, contexts), their fields and relations, the values that exist in this deployment, rules '
    + 'and worked examples. Call this once before your first run_query. With "attributes" (entity names) it '
    + 'returns only the deployment\'s own extra attributes of those entities.',
  permission: 'data.read.reports',
  // Scoped: the reference describes the schema, not records. Its value lists
  // are deployment metadata (type names, system names, context types), the
  // same for every caller; a context owner is told their scope on top.
  owner: 'scoped',
  inputSchema: {
    type: 'object',
    properties: {
      attributes: {
        type: 'array',
        items: { type: 'string', enum: Object.keys(ENTITIES) },
        description: 'List the deployment\'s own attributes ("ext." fields) of these entities instead of the reference.',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const wanted = Array.isArray(args?.attributes) ? args.attributes.filter(e => ENTITIES[e]) : null;
    if (wanted?.length) {
      const block = attributesBlock(await loadExtFields(), wanted);
      return { content: [{ type: 'text', text: block || `No extra attributes for ${wanted.join(', ')}.` }], rowCount: null };
    }
    const [values, extFields] = await Promise.all([loadValues(), loadExtFields()]);
    const ownerPreface = rowScopeOf(ctx) ? OWNER_PREFACE : '';
    const guide = [ownerPreface, PREFACE, buildSystemPrompt(), contextBlock(), buildValuesBlock(values), attributesSummary(extFields)]
      .filter(Boolean).join('\n\n');
    return { content: [{ type: 'text', text: guide }], rowCount: null };
  },
};

// The spec validator ignores a sort it cannot read, which leaves the rows
// silently unsorted; tell the assistant instead.
function badSort(sort) {
  return sort !== undefined && (sort === null || typeof sort !== 'object' || Array.isArray(sort) || typeof sort.field !== 'string');
}

// A cut-off answer says how many there are: counted by running the definition
// again up to the engine's own limit, only when the first run was cut off —
// under the same scope, so the total is never a figure from outside it.
async function countAll(definition, substitutions, scope) {
  const all = await runSpec({ ...definition, limit: MAX_LIMIT }, substitutions, { scope });
  if (!all.ok) return {};
  return all.truncated ? { totalAtLeast: MAX_LIMIT } : { total: all.rows.length };
}

export const runQuery = {
  name: 'run_query',
  title: 'Answer a question with a query',
  description:
    'Answer a question about accounts, persons, groups, roles, applications, access, owners, contexts or changes by '
    + 'running a report definition (see describe_data_model for the format — it is JSON, never SQL). Read-only. Returns '
    + `the rows (capped at maxRows, default ${DEFAULT_ROWS}, max ${MAX_ROWS}) each with its id and link, the columns, a `
    + 'plain-language explanation of what was run, and "truncated": true with the full "total" when there are more rows.',
  permission: 'data.read.reports',
  // Scoped: for a context owner the definition is compiled under their row
  // scope (nlreports/scope.js) — the report's own table, every relation and
  // every relation column — before anything is filtered, counted or grouped.
  owner: 'scoped',
  inputSchema: {
    type: 'object',
    properties: {
      definition: {
        type: 'object',
        description: 'The report definition: { entity, match, conditions, columns, groupBy?, sort?: { field, direction } }.',
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
    if (badSort(definition.sort)) {
      return errorResult('sort must be one object: {"field": "<field>", "direction": "asc" or "desc"}.');
    }
    const limit = rowLimit(args.maxRows);
    const substitutions = callerSubstitutions(await ctx.caller());
    const scope = rowScopeOf(ctx);
    // Ask for one row more than we show, so a cut-off answer is reported as one.
    const result = await runSpec({ ...definition, limit: limit + 1 }, substitutions, { scope });
    if (!result.ok) {
      return errorResult(result.confirm ? 'Did you mean one of these?' : 'The definition is not valid.', {
        errors: result.errors,
        choices: result.confirm?.choices,
      });
    }
    const counted = result.rows.length > limit ? await countAll(definition, substitutions, scope) : {};
    return tableResult({
      scope: scopeOf(ctx),
      explanation: result.explanation,
      columns: result.columns,
      ...counted,
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
