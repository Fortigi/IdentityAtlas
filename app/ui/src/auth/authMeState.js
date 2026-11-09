// Shaping /api/auth-me's response into the provider's permission state.
//
// Extracted from AuthGateProvider so the mapping can be unit-tested without a
// MSAL harness — the same reason authFetchHeaders.js sits beside it. The
// provider keeps the fetch and the setState; these two decide what that state
// contains.

/**
 * The state for "we could not establish what this user may do".
 *
 * Fails CLOSED: no permissions and no wildcard, so every write control stays
 * hidden. A degraded auth response must never read as "full access", which is
 * what an empty-but-wildcard state would do.
 */
export function degradedPermState() {
  return { permissions: new Set(), roles: [], hasWildcard: false, loaded: true, me: null, contextOwner: null };
}

/**
 * The state for a successful /api/auth-me response.
 *
 * Every field is defaulted: the endpoint answers before the schema is ready and
 * in open mode, and in both cases some keys are absent. `me` is the signed-in
 * user mapped onto crawled data (see api/auth/resolveMe.js) — null whenever
 * nothing matched, which consumers must treat as ordinary rather than an error.
 * `contextOwner` is set only for a caller let in as a context owner (no
 * Identity Atlas role, Accountable/Responsible for a context): { contexts }.
 */
export function permStateFromAuthMe(body) {
  return {
    permissions: new Set(body?.permissions || []),
    roles: body?.roles || [],
    hasWildcard: !!body?.hasWildcard,
    loaded: true,
    me: body?.me || null,
    contextOwner: body?.contextOwner || null,
  };
}

/**
 * True when the signed-in user is here only as a context owner: the API let
 * them in for the contexts they answer for (`contextOwner`) and they hold no
 * permission of their own. Such a user gets the bare owner page instead of the
 * app — every other screen would answer 403. Somebody who is both an owner AND
 * holds a real role gets the ordinary app (the API never scopes them).
 */
export function isContextOwnerSession({ permissionsLoaded, hasWildcard, permissions, contextOwner } = {}) {
  if (!permissionsLoaded || hasWildcard) return false;
  if (permissions && permissions.size > 0) return false;
  return Array.isArray(contextOwner?.contexts) && contextOwner.contexts.length > 0;
}
