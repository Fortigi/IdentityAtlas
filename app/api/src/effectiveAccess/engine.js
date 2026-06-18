// Effective-access engine — core resolution.
//
// P1 scope: principal-side expansion (holders = a principal plus the groups they transitively
// belong to) + gather of declared grants + policy resolution (AdditiveAllow). This is the
// substrate the nested-group expand migrates onto. Containment DOWN-expansion (scope/folder
// inheritance) is P2; deny-aware resolution is P3. See docs/architecture/effective-access-engine.md.
//
// Everything here is read-only and bounded: every expansion is capped and reports truncation
// explicitly (never silently dropped, spec §7).

import * as db from '../db/connection.js';
import { getPolicy, DEFAULT_POLICY, badgeForAce } from './policies.js';
import { getSyncVersion } from '../lib/syncVersion.js';
import { capabilityResourceId } from '../lib/capabilityId.js';

export const DEFAULTS = {
  maxDepth: 50,
  maxNodesPerExpansion: 1000,
  maxHoldersPerExpansion: 500,
  cacheMaxEntries: 5000,
};

// Resource types that can act as principals — i.e. a member "belongs to" them. A membership
// edge is a ResourceAssignment whose resourceId is one of these and whose principalId is the
// member. Extend as more group-like sources land (Azure AD groups, Omada usergroups, ...).
// NOTE (P1): this list is the current interpretation of "group"; the nested-group parity tests
// (slice 6) validate it against the legacy endpoint's behavior.
export const GROUP_RESOURCE_TYPES = ['EntraGroup'];

// ── Minimal count-bounded LRU ────────────────────────────────────────────────
// P1 placeholder for the `lru-cache` package (spec D3/D8 prescribe a byte-bounded cache); the
// correctness-relevant behavior — keying on dataVersion so a completed sync invalidates every
// entry — is identical. Swap the implementation when the dependency is wired; callers don't change.
function createLru(max) {
  const map = new Map(); // insertion-ordered → front = oldest
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v); // move to most-recent
      return v;
    },
    set(key, v) {
      if (map.has(key)) map.delete(key);
      map.set(key, v);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}

const cache = createLru(DEFAULTS.cacheMaxEntries);

// Exposed for tests / admin — drop all cached results (e.g. after a manual data change).
export function clearCache() {
  cache.clear();
}

// ── holders(P) ───────────────────────────────────────────────────────────────
/**
 * A principal plus all groups they transitively belong to. Cycle-safe (visited set) and
 * bounded by maxHoldersPerExpansion; exceeding the bound returns truncated=true rather than
 * dropping silently.
 * @param {string} principalId
 * @param {{maxHolders?: number}} [opts]
 * @returns {Promise<{holders: Set<string>, truncated: boolean}>}
 */
export async function getHolders(principalId, opts = {}) {
  const max = opts.maxHolders ?? DEFAULTS.maxHoldersPerExpansion;
  const holders = new Set([principalId]);
  let frontier = [principalId];
  let truncated = false;

  while (frontier.length > 0 && !truncated) {
    const { rows } = await db.query(
      `SELECT DISTINCT ra."resourceId" AS gid
         FROM "ResourceAssignments" ra
         JOIN "Resources" r ON r.id = ra."resourceId"
        WHERE ra."principalId" = ANY($1)
          AND r."resourceType" = ANY($2)`,
      [frontier, GROUP_RESOURCE_TYPES],
    );
    const next = [];
    for (const { gid } of rows) {
      if (holders.has(gid)) continue; // cycle or already collected
      if (holders.size >= max) {
        truncated = true;
        break;
      }
      holders.add(gid);
      next.push(gid);
    }
    frontier = next;
  }
  return { holders, truncated };
}

// ── resolve one (principal, resource) ────────────────────────────────────────
/**
 * Effective access of a principal on a single resource. P1: direct grants + grants reached via
 * group membership (the holder set). No containment inheritance yet (P2).
 * @returns {Promise<{effective:string, badge:string|null, decisiveAce:object|null, truncated:object|null}>}
 */
export async function resolveForPrincipalOnResource(resourceId, principalId, opts = {}) {
  const policy = getPolicy(opts.policy ?? DEFAULT_POLICY);
  const { holders, truncated: holdersTruncated } = await getHolders(principalId, opts);

  const { rows } = await db.query(
    `SELECT ra."principalId" AS holder, ra."effect" AS effect
       FROM "ResourceAssignments" ra
      WHERE ra."resourceId" = $1
        AND ra."principalId" = ANY($2)`,
    [resourceId, Array.from(holders)],
  );

  const aces = rows.map((r) => ({
    effect: r.effect ?? 'allow', // pre-038 rows / mocks: absent effect means allow (spec §15.6)
    distance: 0,
    explicit: r.holder === principalId, // direct iff the principal themself holds it
    viaGroupId: r.holder === principalId ? null : r.holder,
  }));

  const res = policy.resolve(aces);
  return {
    effective: res.effective,
    badge: res.decisiveAce ? badgeForAce(res.decisiveAce) : null,
    decisiveAce: res.decisiveAce,
    truncated: holdersTruncated ? { holders: holders.size } : null,
  };
}

// ── cached + observable entrypoint ───────────────────────────────────────────
/**
 * Cached resolve. Keyed on (resource, principal, policy, dataVersion) — a completed sync bumps
 * dataVersion (WorkerConfig.syncVersion) and so invalidates every entry at once. Emits one
 * structured observability line per call (spec §19).
 */
export async function effectiveAccess(resourceId, principalId, opts = {}) {
  const started = Date.now();
  const policyName = opts.policy ?? DEFAULT_POLICY;
  const dataVersion = await getSyncVersion();
  const key = `${resourceId}:${principalId}:${policyName}:${dataVersion}`;

  const cached = cache.get(key);
  if (cached !== undefined) {
    logResolve({ resourceId, principalId, cacheHit: true, dataVersion, started, result: cached });
    return cached;
  }

  const result = await resolveForPrincipalOnResource(resourceId, principalId, opts);
  cache.set(key, result);
  logResolve({ resourceId, principalId, cacheHit: false, dataVersion, started, result });
  return result;
}

function logResolve({ resourceId, principalId, cacheHit, dataVersion, started, result }) {
  try {
    console.log(
      JSON.stringify({
        event: 'effective-access-resolve',
        focusNode: resourceId,
        principalId,
        cacheHit,
        effective: result.effective,
        truncated: !!result.truncated,
        durationMs: Date.now() - started,
        dataVersion,
      }),
    );
  } catch {
    /* logging must never break a request */
  }
}

// ── P2: containment (scope/folder/site inheritance) ──────────────────────────
/**
 * Walk `Contains` edges UPWARD from a focus node, collecting ancestor nodes and their distance
 * (0 = the focus node itself). Ascent stops the moment it would cross an edge with
 * `propagates=false` — the nearest inheritance-break boundary (spec §7). DAG-safe (a node is
 * admitted once, by its first unblocked path), depth- and node-capped.
 * @returns {Promise<{depthByNode: Map<string, number>, truncated: boolean}>}
 */
export async function getAncestorNodes(nodeId, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;
  const maxNodes = opts.maxNodesPerExpansion ?? DEFAULTS.maxNodesPerExpansion;
  const depthByNode = new Map([[nodeId, 0]]);
  let frontier = [nodeId];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0 && !truncated) {
    if (depth >= maxDepth) {
      truncated = true;
      break;
    }
    depth++;
    const { rows } = await db.query(
      `SELECT DISTINCT rr."parentResourceId" AS parent
         FROM "ResourceRelationships" rr
        WHERE rr."relationshipType" = 'Contains'
          AND rr."childResourceId" = ANY($1)
          AND COALESCE((rr."extendedAttributes" ->> 'propagates')::boolean, true) = true`,
      [frontier],
    );
    const next = [];
    for (const { parent } of rows) {
      if (depthByNode.has(parent)) continue; // already admitted via a shorter/equal path
      if (depthByNode.size >= maxNodes) {
        truncated = true;
        break;
      }
      depthByNode.set(parent, depth);
      next.push(parent);
    }
    frontier = next;
  }
  return { depthByNode, truncated };
}

/**
 * Effective access of a principal AT a node, including capabilities inherited from ancestor
 * nodes through `Contains`. The capability rides constant down the tree; an inherited
 * `capability @ node` is SYNTHESIZED (never stored) and carries the same deterministic id as a
 * stored grant for the same pair, so the two collapse into one row (spec §11). One row per
 * capability the principal effectively holds at the node. P2 down-expansion.
 * @returns {Promise<{nodeId:string, principalId:string, capabilities:object[], truncated:object|null}>}
 */
export async function effectiveAccessAtNode(nodeId, principalId, opts = {}) {
  const policy = getPolicy(opts.policy ?? DEFAULT_POLICY);
  const { holders, truncated: holdersTruncated } = await getHolders(principalId, opts);
  const { depthByNode, truncated: ancestorsTruncated } = await getAncestorNodes(nodeId, opts);
  const ancestorIds = [...depthByNode.keys()];

  // Capability-resources targeting the focus node or any ancestor, with a grant held by the
  // principal or one of their groups. The targetNodeId is exposed via a generated column.
  const { rows } = await db.query(
    `SELECT r."capabilityId" AS cap,
            r."targetNodeId"  AS target,
            ra."principalId"  AS holder,
            ra."effect"       AS effect,
            ra."propagationScope" AS scope
       FROM "Resources" r
       JOIN "ResourceAssignments" ra ON ra."resourceId" = r.id
      WHERE r."capabilityId" IS NOT NULL
        AND r."targetNodeId" = ANY($1)
        AND ra."principalId" = ANY($2)`,
    [ancestorIds, Array.from(holders)],
  );

  // Group ACEs by capability, honouring propagationScope + distance.
  const byCap = new Map();
  for (const row of rows) {
    const distance = depthByNode.get(row.target);
    if (distance === undefined) continue;
    const atFocus = distance === 0;
    const scope = row.scope ?? 'selfAndDescendants';
    const reaches = atFocus
      ? scope === 'self' || scope === 'selfAndDescendants'
      : scope === 'descendants' || scope === 'selfAndDescendants';
    if (!reaches) continue;

    const ace = {
      effect: row.effect ?? 'allow',
      distance,
      explicit: atFocus,
      viaGroupId: row.holder === principalId ? null : row.holder,
    };
    if (!byCap.has(row.cap)) byCap.set(row.cap, []);
    byCap.get(row.cap).push(ace);
  }

  const capabilities = [];
  for (const [cap, aces] of byCap) {
    const res = policy.resolve(aces);
    if (res.effective === 'none') continue;
    capabilities.push({
      capabilityId: cap,
      capabilityResourceId: capabilityResourceId(nodeId, cap),
      effective: res.effective,
      badge: res.decisiveAce ? badgeForAce(res.decisiveAce) : null,
    });
  }
  capabilities.sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)); // stable ordering

  const truncated =
    holdersTruncated || ancestorsTruncated
      ? {
          holders: holdersTruncated ? holders.size : undefined,
          ancestors: ancestorsTruncated ? depthByNode.size : undefined,
        }
      : null;
  return { nodeId, principalId, capabilities, truncated };
}
