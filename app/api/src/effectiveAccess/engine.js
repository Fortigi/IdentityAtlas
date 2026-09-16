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
import {
  groupAtNodeAces,
  resolveAtNodeCapabilities,
  atNodeTruncation,
  groupForNodeGrants,
  emitNodeRows,
} from './engine.helpers.js';
import { createLru } from './lru.js';

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
export const GROUP_RESOURCE_TYPES = ['Group'];

// ── Minimal count-bounded LRU ────────────────────────────────────────────────
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
  // Unambiguous key encoding — a delimiter-joined string could collide when a node id itself
  // contains the delimiter (e.g. a future filesystem node id like "C:\Finance"). JSON.stringify
  // of the parts is collision-free for any id content.
  const key = JSON.stringify([resourceId, principalId, policyName, dataVersion]);

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
// Walk `Contains` edges in one direction ('up' = ancestors, 'down' =
// descendants) from a focus node, collecting nodes + distance (0 = focus).
// Stops at a propagates=false edge. DAG-safe, depth- and node-capped.
async function walkContainsNodes(nodeId, direction, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;
  const maxNodes = opts.maxNodesPerExpansion ?? DEFAULTS.maxNodesPerExpansion;
  // selCol = the neighbour we collect; whereCol = the side we match the frontier
  // on; `alias` is the row key (kept direction-specific: parent / child).
  const [selCol, whereCol, alias] = direction === 'up'
    ? ['parentResourceId', 'childResourceId', 'parent']
    : ['childResourceId', 'parentResourceId', 'child'];
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
      `SELECT DISTINCT rr."${selCol}" AS ${alias}
         FROM "ResourceRelationships" rr
        WHERE rr."relationshipType" = 'Contains'
          AND rr."${whereCol}" = ANY($1)
          AND COALESCE((rr."extendedAttributes" ->> 'propagates')::boolean, true) = true`,
      [frontier],
    );
    const next = [];
    for (const row of rows) {
      const node = row[alias];
      if (depthByNode.has(node)) continue; // already admitted via a shorter/equal path
      if (depthByNode.size >= maxNodes) {
        truncated = true;
        break;
      }
      depthByNode.set(node, depth);
      next.push(node);
    }
    frontier = next;
  }
  return { depthByNode, truncated };
}

export async function getAncestorNodes(nodeId, opts = {}) {
  return walkContainsNodes(nodeId, 'up', opts);
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

  // Group ACEs by capability (honouring propagationScope + distance), then resolve each to one row.
  const byCap = groupAtNodeAces(rows, depthByNode, principalId);
  const capabilities = resolveAtNodeCapabilities(byCap, policy, nodeId);
  const truncated = atNodeTruncation(holdersTruncated, holders, ancestorsTruncated, depthByNode);
  return { nodeId, principalId, capabilities, truncated };
}

// ── P2 down-expansion: descendants + container fanout ─────────────────────────
/**
 * Walk `Contains` edges DOWNWARD from a focus node — the mirror of getAncestorNodes. Collects
 * descendant nodes and their distance (0 = the focus node). Descent stops the moment it would
 * cross an edge with `propagates=false`. DAG-safe (a node is admitted once), depth- and node-capped.
 * @returns {Promise<{depthByNode: Map<string, number>, truncated: boolean}>}
 */
export async function getDescendantNodes(nodeId, opts = {}) {
  return walkContainsNodes(nodeId, 'down', opts);
}

/**
 * Fan a capability-resource OUT over its containment subtree, for the matrix `>` expand. Given a
 * focus capability-resource (`capabilityId` @ `targetNodeId`), returns one synthesized child
 * capability-resource per descendant node plus the principals who inherit it (the focus row's own
 * holders, badged `Indirect` — the capability rides constant down the tree). The synthesized child
 * ids are deterministic (capabilityResourceId(node, cap)), so a child that IS separately declared
 * collapses onto the same row. Returns the matrix `{ groups, memberships }` shape, or `null` when
 * the id is not a capability-resource (the caller then falls back to group-membership expansion).
 *
 * This is the generic containment fanout — it serves Azure RM, DevOps, FileShares and SharePoint
 * identically; nothing is source-specific.
 * @returns {Promise<{groups: object[], memberships: object[], truncated: object|null}|null>}
 */
export async function expandCapabilityDown(focusResourceId, opts = {}) {
  const { rows: focusRows } = await db.query(
    `SELECT r."capabilityId" AS cap,
            r."targetNodeId"  AS node,
            r."resourceType"  AS rtype,
            r."extendedAttributes" ->> 'roleName' AS rolename
       FROM "Resources" r
      WHERE r.id = $1`,
    [focusResourceId],
  );
  const focus = focusRows[0];
  if (!focus || !focus.cap || !focus.node) return null; // not a capability-resource

  const { depthByNode, truncated } = await getDescendantNodes(focus.node, opts);
  const descendants = [...depthByNode.keys()].filter((n) => n !== focus.node);
  const truncInfo = truncated ? { nodes: depthByNode.size } : null;
  if (descendants.length === 0) return { groups: [], memberships: [], truncated: truncInfo };

  // The focus row's own holders (principals or groups directly granted this capability-resource).
  // They inherit the capability to every descendant node, shown as Indirect. Group holders are
  // expanded to their members by the existing group-membership fanout, orthogonally.
  const { rows: holderRows } = await db.query(
    `SELECT DISTINCT ra."principalId" AS holder
       FROM "ResourceAssignments" ra
      WHERE ra."resourceId" = $1 AND ra."principalId" IS NOT NULL`,
    [focusResourceId],
  );
  const holders = holderRows.map((h) => h.holder);

  // Scope node display names + an optional short type label the source set (e.g. MG / Sub / RG /
  // Res) so the synthesized row reads "Owner @ RG: name". Generic: the engine just uses whatever
  // label the crawler stored on the node.
  const { rows: nameRows } = await db.query(
    `SELECT id, "displayName" AS name, "extendedAttributes" ->> 'scopeTypeLabel' AS label
       FROM "Resources" WHERE id = ANY($1)`,
    [descendants],
  );
  const metaById = new Map(nameRows.map((r) => [r.id, r]));
  const roleLabel = focus.rolename || focus.cap;

  // A synthesized child id has no stored row (so its detail page would 404). Navigate the row to a
  // resolvable resource: the separately-declared capability-resource if one exists at that node,
  // otherwise the underlying (stored) scope node. The cell-keying id (groupId) stays the synthesized
  // capability id so it collapses with a declared row.
  const childIds = descendants.map((n) => capabilityResourceId(n, focus.cap));
  const { rows: storedRows } = await db.query(`SELECT id FROM "Resources" WHERE id = ANY($1)`, [childIds]);
  const storedIds = new Set(storedRows.map((r) => r.id));

  const groups = [];
  const memberships = [];
  for (const node of descendants) {
    const childId = capabilityResourceId(node, focus.cap);
    const meta = metaById.get(node);
    const scopeName = meta?.name || node;
    const displayName = meta?.label ? `${roleLabel} @ ${meta.label}: ${scopeName}` : `${roleLabel} @ ${scopeName}`;
    groups.push({
      groupId: childId,
      resourceId: storedIds.has(childId) ? childId : node,
      displayName,
      resourceType: focus.rtype,
    });
    for (const h of holders) {
      memberships.push({ groupId: childId, resourceId: childId, memberId: h, membershipType: 'Indirect' });
    }
  }
  return { groups, memberships, truncated: truncInfo };
}

/**
 * Effective access AT a set of focus scope nodes — the engine behind the matrix's resource-context
 * filter ("show everyone who can touch any key vault / any folder, however they got it"). For each
 * focus node it walks `Contains` UP, gathers the capability grants that propagate down to it, and
 * emits one row per (focus node, capability, holder): the synthesized capability-resource id, the
 * holder principal, and the badge (Direct when granted at the node, Indirect when inherited). Unlike
 * effectiveAccessAtNode this resolves ALL holders, so it can fill a matrix column-set. Generic —
 * any source with Contains + capability-resources (Azure, DevOps, file shares, SharePoint).
 * @returns {Promise<{rows: Array<{resourceId:string,nodeId:string,capabilityId:string,displayName:string,principalId:string,membershipType:string}>, truncated: object|null}>}
 */
// Ancestor walk + capability-grant gather for one focus node. Returns the depth map (for scope
// resolution), the raw grant rows, and whether the ancestor walk was capped.
async function grantsForNode(node, opts) {
  const { depthByNode, truncated } = await getAncestorNodes(node, opts);
  const ancestorIds = [...depthByNode.keys()];
  const { rows: grantRows } = await db.query(
    `SELECT r."capabilityId" AS cap,
            r."targetNodeId" AS target,
            r."extendedAttributes" ->> 'roleName' AS rolename,
            r."resourceType"  AS rtype,
            ra."principalId" AS holder,
            ra."effect" AS effect,
            ra."propagationScope" AS scope
       FROM "Resources" r
       JOIN "ResourceAssignments" ra ON ra."resourceId" = r.id
      WHERE r."capabilityId" IS NOT NULL AND r."targetNodeId" = ANY($1) AND ra."principalId" IS NOT NULL`,
    [ancestorIds],
  );
  return { depthByNode, grantRows, truncated };
}

export async function effectiveAccessForNodes(focusNodeIds, opts = {}) {
  const policy = getPolicy(opts.policy ?? DEFAULT_POLICY);
  const focus = [...new Set((focusNodeIds || []).map(String))];
  if (focus.length === 0) return { rows: [], truncated: null };

  // Friendly names for the focus scope nodes (for "role @ scope" row labels).
  const { rows: nameRows } = await db.query(
    `SELECT id, "displayName" AS name, "extendedAttributes" ->> 'scopeTypeLabel' AS label
       FROM "Resources" WHERE id = ANY($1)`,
    [focus],
  );
  const metaById = new Map(nameRows.map((r) => [r.id, r]));

  const rows = [];
  let truncated = false;
  for (const node of focus) {
    const { depthByNode, grantRows, truncated: tr } = await grantsForNode(node, opts);
    if (tr) truncated = true;
    const byCapHolder = groupForNodeGrants(grantRows, depthByNode);
    rows.push(...emitNodeRows(byCapHolder, policy, node, metaById.get(node)));
  }
  return { rows, truncated: truncated ? { ancestors: true } : null };
}
