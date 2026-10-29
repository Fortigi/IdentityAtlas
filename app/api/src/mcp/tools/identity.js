// MCP tools that orient the assistant: who is asking, and which records a name
// refers to.

import { query } from '../../db/connection.js';
import { ENTITIES } from '../../nlreports/catalog.js';
import { searchNames } from '../../nlreports/references.js';
import { detailLink, jsonResult, errorResult } from '../result.js';

export const whoAmI = {
  name: 'whoami',
  title: 'Who am I',
  description:
    'The signed-in user this assistant acts for: name, their account in Identity Atlas (if the directory has '
    + 'it), and their roles. Use it to answer questions about "me" / "my", or to explain why something is not allowed.',
  permission: null,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, ctx) {
    const caller = await ctx.caller();
    const user = ctx.user || {};
    return jsonResult({
      name: user.name || null,
      username: user.preferred_username || user.upn || null,
      roles: user.roles || [],
      account: caller
        ? { ...caller, link: detailLink(ctx.baseUrl, { kind: 'user', id: caller.principalId }) }
        : null,
      note: caller ? undefined : 'Your sign-in is not linked to an account in the crawled directory, so "my …" questions cannot be answered.',
    });
  },
};

// Entities a name can be looked up in. `change` has no name.
export const SEARCHABLE = Object.keys(ENTITIES).filter(e => e !== 'change');
const DEFAULT_KINDS = ['identity', 'account', 'resource'];

export const search = {
  name: 'search',
  title: 'Find records by name',
  description:
    'Find people, accounts, groups, roles, applications or contexts by (part of) their name, with fuzzy matching. '
    + 'Use it to resolve a name the user mentions to the exact record before querying, or when a query said '
    + '"Did you mean". Returns id, exact name, type and a link per match.',
  permission: 'data.read',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 2, maxLength: 100 },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: SEARCHABLE },
        description: `Where to look. Default: ${DEFAULT_KINDS.join(', ')} (resource covers groups, roles and applications).`,
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const text = String(args?.text || '').trim();
    if (text.length < 2 || text.length > 100) return errorResult('text must be 2 to 100 characters.');
    const kinds = Array.isArray(args.kinds) && args.kinds.length
      ? [...new Set(args.kinds)].filter(k => SEARCHABLE.includes(k))
      : DEFAULT_KINDS;
    // A record can be found twice — a group is also a resource, a user also an
    // account — so the first (= best-scoring, after the sort) entry per id wins.
    const found = [];
    for (const kind of kinds) {
      for (const m of await searchNames(query, kind, text)) {
        found.push({ ...m, entity: kind, link: detailLink(ctx.baseUrl, { kind: ENTITIES[kind].detailKind, id: m.id }) });
      }
    }
    found.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const matches = found.filter(m => !seen.has(m.id) && seen.add(m.id));
    return jsonResult({ matches }, matches.length);
  },
};
