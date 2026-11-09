// The owner-access scope service: one object per context owner that answers
// "may this caller open that object?" for any API surface that runs on their
// behalf — the REST endpoints today (middleware/contextOwnerMode.js), the MCP
// server later (#1508). The tiers themselves are defined in ./tiers.js.
//
//   const access = createOwnerAccess(owner.contextIds);
//   await access.canOpen('user', id)                 → true | false
//   await access.tierOf('resource', id)              → 'team' | 'held' | null
//   await access.accessibleIds('principal', [ids])   → Set of lower-cased ids
//
// Kinds can be given in the data model's words (principal, identity, resource,
// context) or the UI's (user, group, access-package, business-role); see
// normaliseKind. A context opens when it is one of the owner's context ids.
//
// Answers are cached: per object for the life of the access object (one
// request), and across requests in a small LRU keyed by the owner's scope and
// expiring after CACHE_TTL_MS. The tiers move only when a sync or an analyst
// changes memberships or assignments, so a minute's staleness is the price of
// not re-running the EXISTS checks for every graph node a page fans out; the
// scope itself (which contexts) is still resolved on every request.

import * as db from '../../db/connection.js';
import { createLru } from '../../effectiveAccess/lru.js';
import { classifyTiers, cleanIds } from './tiers.js';

export const CACHE_TTL_MS = 60_000;
export const CACHE_MAX = 20_000;

const KIND_ALIASES = {
  principal: 'principal', user: 'principal',
  identity: 'identity',
  resource: 'resource', group: 'resource', 'access-package': 'resource', 'business-role': 'resource',
  context: 'context',
  member: 'member',
};

/** The classifier kind for a data-model or UI kind, or null when there is none. */
export function normaliseKind(kind) {
  return Object.hasOwn(KIND_ALIASES, kind) ? KIND_ALIASES[kind] : null;
}

const sharedCache = createLru(CACHE_MAX);

/** Drop every cached answer (tests; an admin action that changes memberships could too). */
export function clearOwnerAccessCache() {
  sharedCache.clear();
}

export function createOwnerAccess(contextIds, { getPool = db.getPool, cache = sharedCache, now = Date.now } = {}) {
  const scope = new Set([...contextIds].map(id => String(id).toLowerCase()));
  const scopeKey = [...scope].sort().join(',');
  const local = new Map(); // `${kind}|${id}` → tier | null, for this object's life

  const cacheKey = (kind, id) => `${scopeKey}|${kind}|${id}`;

  function cached(kind, id) {
    const k = `${kind}|${id}`;
    if (local.has(k)) return { hit: true, tier: local.get(k) };
    const entry = cache.get(cacheKey(kind, id));
    if (entry && now() - entry.at < CACHE_TTL_MS) {
      local.set(k, entry.tier);
      return { hit: true, tier: entry.tier };
    }
    return { hit: false };
  }

  function remember(kind, id, tier) {
    local.set(`${kind}|${id}`, tier);
    cache.set(cacheKey(kind, id), { tier, at: now() });
  }

  // Map<id, tier | null> for every well-formed id of the batch.
  async function tiersOf(rawKind, ids) {
    const kind = normaliseKind(rawKind);
    const wanted = cleanIds(ids);
    const out = new Map();
    if (!kind) return out;
    if (kind === 'context') {
      for (const id of wanted) out.set(id, scope.has(id) ? 'team' : null);
      return out;
    }
    const missing = [];
    for (const id of wanted) {
      const c = cached(kind, id);
      if (c.hit) out.set(id, c.tier);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const found = await classifyTiers(await getPool(), scope, kind, missing);
      for (const id of missing) {
        const tier = found.get(id) ?? null;
        remember(kind, id, tier);
        out.set(id, tier);
      }
    }
    return out;
  }

  async function accessibleIds(kind, ids) {
    const tiers = await tiersOf(kind, ids);
    return new Set([...tiers].filter(([, tier]) => tier !== null).map(([id]) => id));
  }

  async function tierOf(kind, id) {
    const tiers = await tiersOf(kind, [id]);
    return tiers.get(String(id ?? '').toLowerCase()) ?? null;
  }

  async function canOpen(kind, id) {
    return (await tierOf(kind, id)) !== null;
  }

  return { contextIds: scope, tiersOf, accessibleIds, tierOf, canOpen };
}
