// The MCP server on behalf of a context owner — who qualifies, and how every
// answer says what it covers.
//
// A context owner (Accountable or Responsible for a context, no Identity Atlas
// role — docs/architecture/context-owner-access.md) may use MCP when BOTH
// relative-permission switches are on: context-owner access and "context
// owners may use MCP" (auth/contextOwnerSetting.js). They then get exactly the
// scope the REST API gives them, enforced by the same code:
//   - which objects open: auth/ownerAccess (tiers), applied INSIDE every query
//     the assistant runs (nlreports/scope.js), and to every name lookup;
//   - which reports run: the REST allow-list verdict (auth/contextOwnerScope.js
//     + middleware/contextOwnerMode.js settleOwnerVerdict).
// Nothing in this directory decides who may see what on its own.
//
// Every data result carries `scope` (scopeOf below), so an assistant can never
// mistake "500 users you may see" for "the organisation has 500 users". It is
// separate from `truncated`, which only ever means the row cap cut the list.

import { resolveContextOwner } from '../auth/contextOwner.js';
import { isContextOwnerMcpEnabled } from '../auth/contextOwnerSetting.js';
import { createOwnerAccess } from '../auth/ownerAccess/index.js';
import { createRowScope } from '../nlreports/scope.js';

/**
 * The context owner behind a verified MCP token — { contexts, contextIds,
 * access, rowScope } — or null when the switches are off or the caller answers
 * for no context. Errors propagate: the caller fails closed.
 */
export async function resolveMcpContextOwner(user, { enabled = isContextOwnerMcpEnabled, resolve = resolveContextOwner } = {}) {
  if (!(await enabled())) return null;
  const owner = await resolve(user);
  if (!owner) return null;
  return { ...owner, access: createOwnerAccess(owner.contextIds), rowScope: createRowScope(owner.contextIds) };
}

/** The row scope a tool must run under for this caller, or null (unscoped). */
export const rowScopeOf = (ctx) => ctx?.user?.contextOwner?.rowScope ?? null;

export const OWNER_SCOPE_DESCRIPTION =
  'Only what you may see as the Accountable or Responsible person for the contexts listed here: their members, '
  + 'what those members hold (or, for an application, who holds it), and their sub-units. Counts and totals cover '
  + 'that part only — they are not figures for the whole organisation, and the size of the rest is not disclosed.';

export const ROLE_SCOPE_DESCRIPTION = 'Everything your Identity Atlas role allows you to read.';

/**
 * What a result covers. `restricted: true` means authorization limited it (as
 * opposed to `truncated`, the row cap). An owner's own contexts are named; the
 * size of what lies outside them never is.
 */
export function scopeOf(ctx) {
  const owner = ctx?.user?.contextOwner;
  if (!owner) return { restricted: false, basis: 'role', description: ROLE_SCOPE_DESCRIPTION };
  return {
    restricted: true,
    basis: 'context-owner',
    description: OWNER_SCOPE_DESCRIPTION,
    contexts: (owner.contexts || []).map(c => ({ id: c.id, name: c.displayName, role: c.role })),
  };
}
