// Effective (inherited) access for the matrix.
//
// Azure-style access is declared on capability-resources (role@scope) and
// inherited down the Contains hierarchy — "Owner on the subscription" ⇒ Indirect
// on every resource beneath it. The matrix's declared matview never sees this:
// it reads stored grants only, and the scope nodes the resource filter selects
// (key vaults, a region, …) carry none — the grants live on capability-resources
// at or above them. So when the user opts in ("include inherited access") AND the
// matrix is scoped to a bounded set of resources, we ask the effective-access
// engine for the effective capabilities AT those scope nodes and fold the result
// into the matrix. Generic: any source with Contains + capability-resources.
//
// Bounded-scope only — the engine never fires for an unscoped (whole-tenant)
// matrix, so "include inherited" can't accidentally fan inheritance over
// everything.

import { createHash } from 'crypto';
import { createParams } from '../db/sqlParams.js';
import * as db from '../db/connection.js';
import { effectiveAccessForNodes } from '../effectiveAccess/engine.js';
import { getSyncVersion } from '../lib/syncVersion.js';
import { resolveAttrExpr } from './attrExpr.js';
import { visibleKeyExpr } from './attributeCut.js';

// ── Effective-access cache (Phase 3: cache-by-sync) ─────────────────────────
// Effective access can only change on a crawl, so we cache the engine's full
// rows for a scope keyed by (sync-version, scope-hash). A crawl bumps the
// sync-version → old keys become unreachable and age out. The subject filter is
// applied per-request *after* the cache, so different subject scopes over the
// same resource scope share one entry. Bounded FIFO so memory can't grow.
const EFF_CACHE = new Map();
const EFF_CACHE_MAX = 256;

async function cachedEffectiveAccess(nodeIds) {
  const hash = createHash('sha1').update([...nodeIds].sort().join(',')).digest('hex');
  let version = 0;
  try { version = await getSyncVersion(); } catch { /* fall back to a single bucket */ }
  const key = `${version}|${hash}`;
  const hit = EFF_CACHE.get(key);
  if (hit) return hit;
  const { rows } = await effectiveAccessForNodes(nodeIds);
  if (EFF_CACHE.size >= EFF_CACHE_MAX) EFF_CACHE.delete(EFF_CACHE.keys().next().value);
  EFF_CACHE.set(key, rows);
  return rows;
}

// The scope-node ids inside the current resource scope. `built.resource(bind)`
// renders a parenthesised "(SELECT id FROM "Resources" WHERE …)" whose values
// are appended to this query's own positional params via `bind`.
// Capability-resources (role@scope) carry a capabilityId and are NOT part of the
// containment hierarchy the engine walks, so exclude them.
async function scopedNodeIds(p, built) {
  const { params, bind } = createParams();
  const resourceSql = built.resource(bind).sql;
  const r = await p.query(
    `SELECT id FROM "Resources" WHERE id IN ${resourceSql} AND "capabilityId" IS NULL`,
    params,
  );
  return r.rows.map((x) => x.id);
}

// The principal ids inside the current subject scope, so inherited rows honour
// the subject filter too. Returns null when there is no subject scope.
async function scopedPrincipalIds(p, built, rowType) {
  if (!built.hasSubject) return null;
  const { params, bind } = createParams();
  const subjectSql = built.subject(bind).sql;
  const sql = rowType === 'identity'
    ? `SELECT "principalId" AS id FROM "IdentityMembers" WHERE "identityId" IN ${subjectSql}`
    : `SELECT id FROM "Principals" WHERE id IN ${subjectSql}`;
  const r = await p.query(sql, params);
  return new Set(r.rows.map((x) => x.id));
}

// Produce flat per-(capability, subject) rows in the exact shape the /matrix/data
// flat path emits, for the inherited access at the scoped resources.
export async function buildInheritedFlatRows(p, built, rowType, subjectCols) {
  if (!built.hasResource) return [];                 // bounded scope only
  const nodeIds = await scopedNodeIds(p, built);
  if (!nodeIds.length) return [];

  const eff = await cachedEffectiveAccess(nodeIds);
  if (!eff.length) return [];

  const subjScope = await scopedPrincipalIds(p, built, rowType);
  const rows = subjScope ? eff.filter((e) => subjScope.has(e.principalId)) : eff;
  if (!rows.length) return [];

  const pids = [...new Set(rows.map((r) => r.principalId))];
  const dynCols = subjectCols
    .filter((c) => !['displayName', 'email'].includes(c.name))
    .map((c) => c.name);
  const colSel = dynCols.length ? ', ' + dynCols.map((n) => `"${n}"`).join(', ') : '';

  const [{ rows: princ }, { rows: nodeMeta }] = await Promise.all([
    db.query(
      `SELECT id, "displayName", "email", "principalType", "extendedAttributes"${colSel}
         FROM "Principals" WHERE id = ANY($1)`, [pids]),
    db.query(
      `SELECT r.id, r."systemId", s."displayName" AS "systemName"
         FROM "Resources" r LEFT JOIN "Systems" s ON s.id = r."systemId"
        WHERE r.id = ANY($1)`, [nodeIds]),
  ]);
  const byId = new Map(princ.map((u) => [u.id, u]));
  const nodeById = new Map(nodeMeta.map((n) => [n.id, n]));

  // rowType=identity rolls each holder principal up to its identities.
  let identByPrincipal = null;
  if (rowType === 'identity') {
    const { rows: im } = await db.query(
      `SELECT im."principalId" AS pid, i.id, i."displayName", i."email"
         FROM "IdentityMembers" im JOIN "Identities" i ON i.id = im."identityId"
        WHERE im."principalId" = ANY($1)`, [pids]);
    identByPrincipal = new Map();
    for (const x of im) {
      if (!identByPrincipal.has(x.pid)) identByPrincipal.set(x.pid, []);
      identByPrincipal.get(x.pid).push(x);
    }
  }

  const out = [];
  const emit = (e, u, memberId, memberName, memberUpn, memberType) => {
    const node = nodeById.get(e.nodeId) || {};
    const row = {
      resourceId: e.resourceId, groupId: e.resourceId,
      resourceDisplayName: e.displayName, groupDisplayName: e.displayName,
      resourceType: e.resourceType, groupTypeCalculated: e.resourceType,
      resourceDescription: null, groupDescription: null,
      systemId: node.systemId ?? null, systemName: node.systemName ?? null,
      memberId, memberDisplayName: memberName, memberUPN: memberUpn, memberType,
      membershipType: e.membershipType,
      extendedAttributes: u.extendedAttributes ?? null,
      managedByAccessPackage: false,
      // Carried so the UI can explain an inherited (Indirect) cell on demand
      // (POST /matrix/inheritance-path) — the path that produced the badge.
      inheritedNodeId: e.nodeId, inheritedCapabilityId: e.capabilityId, inheritedPrincipalId: e.principalId,
    };
    for (const n of dynCols) row[n] = u[n] ?? null;
    out.push(row);
  };

  for (const e of rows) {
    const u = byId.get(e.principalId);
    if (!u || u.principalType === '#microsoft.graph.group') continue;
    if (rowType === 'identity') {
      for (const id of (identByPrincipal.get(e.principalId) || [])) {
        emit(e, u, id.id, id.displayName, id.email, 'Identity');
      }
    } else {
      emit(e, u, u.id, u.displayName, u.email, u.principalType);
    }
  }
  return out;
}

// Folded effective counts (Phase 2): the attribute-rollup count cells, but for
// inherited access. Reuses the cached engine rows for the scope and aggregates
// distinct holders per (synthesized capability-resource, group-value), shaped to
// merge into the attribute-rollup response. Bounded-scope + principal rowType.
export async function buildInheritedRollupCounts(p, built, rowType, rollupAttr, principalCols) {
  if (!built.hasResource) return null;
  const nodeIds = await scopedNodeIds(p, built);
  if (!nodeIds.length) return null;
  const eff = await cachedEffectiveAccess(nodeIds);
  if (!eff.length) return null;
  const subjScope = await scopedPrincipalIds(p, built, rowType);
  const rows = subjScope ? eff.filter((e) => subjScope.has(e.principalId)) : eff;
  if (!rows.length) return null;

  const pids = [...new Set(rows.map((r) => r.principalId))];

  // group-value per holder = the roll-up attribute on the principal (COALESCE
  // empty → '(none)', matching buildRollupSql). Plus principalType to drop groups.
  const { attrExpr, error } = rollupAttr ? resolveAttrExpr(rollupAttr, 'pr', principalCols) : { error: true };
  const gvSel = error ? `'(none)'` : `COALESCE(NULLIF((${attrExpr})::text, ''), '(none)')`;
  const { rows: pr } = await db.query(
    `SELECT id, "principalType" AS pt, ${gvSel} AS gv FROM "Principals" pr WHERE id = ANY($1)`, [pids]);
  const gvBy = new Map(pr.map((r) => [r.id, r]));

  const { rows: nodeMeta } = await db.query(
    `SELECT r.id, r."systemId", s."displayName" AS "systemName"
       FROM "Resources" r LEFT JOIN "Systems" s ON s.id = r."systemId" WHERE r.id = ANY($1)`, [nodeIds]);
  const nodeById = new Map(nodeMeta.map((n) => [n.id, n]));

  const resources = new Map();           // resourceId -> meta
  const cells = new Map();               // resourceId -> Map(gv -> Set principal)
  const groupSets = new Map();           // gv -> Set principal
  for (const e of rows) {
    const meta = gvBy.get(e.principalId);
    if (!meta || meta.pt === '#microsoft.graph.group') continue;
    const gv = meta.gv || '(none)';
    if (!resources.has(e.resourceId)) {
      const node = nodeById.get(e.nodeId) || {};
      resources.set(e.resourceId, {
        resourceId: e.resourceId, resourceDisplayName: e.displayName,
        resourceType: e.resourceType, resourceDescription: null,
        systemId: node.systemId ?? null, systemName: node.systemName ?? null,
      });
    }
    let m = cells.get(e.resourceId); if (!m) { m = new Map(); cells.set(e.resourceId, m); }
    let s = m.get(gv); if (!s) { s = new Set(); m.set(gv, s); }
    s.add(e.principalId);
    let gs = groupSets.get(gv); if (!gs) { gs = new Set(); groupSets.set(gv, gs); }
    gs.add(e.principalId);
  }
  if (!resources.size) return null;

  const counts = [];
  for (const [resourceId, m] of cells) {
    for (const [gv, set] of m) counts.push({ resourceId, groupValue: gv, directCount: set.size, governedCount: 0 });
  }
  return {
    resources: [...resources.values()],
    counts,
    groupValues: [...groupSets.keys()],
    groupTotals: [...groupSets.entries()].map(([gv, set]) => ({ groupValue: gv, total: set.size })),
  };
}

// Folded effective counts for the CONTEXT (org-hierarchy) rollup. Same idea as
// buildInheritedRollupCounts, but the group-value of a holder is the frontier
// context node whose subtree contains them (a holder can map to more than one
// when frontier nodes nest). `frontierIds` are the visible cut's node ids.
export async function buildInheritedContextCounts(p, built, rowType, frontierIds) {
  if (!built.hasResource || !Array.isArray(frontierIds) || !frontierIds.length) return null;
  const nodeIds = await scopedNodeIds(p, built);
  if (!nodeIds.length) return null;
  const eff = await cachedEffectiveAccess(nodeIds);
  if (!eff.length) return null;
  const subjScope = await scopedPrincipalIds(p, built, rowType);
  const rows = subjScope ? eff.filter((e) => subjScope.has(e.principalId)) : eff;
  if (!rows.length) return null;
  const pids = [...new Set(rows.map((r) => r.principalId))];

  const { rows: fm } = await db.query(
    `WITH RECURSIVE frontier(fid) AS (SELECT unnest($1::uuid[])),
       subtree(fid, ctx) AS (
         SELECT fid, fid FROM frontier
         UNION ALL
         SELECT s.fid, c.id FROM "Contexts" c JOIN subtree s ON c."parentContextId" = s.ctx)
     -- CYCLE guard: corrupt parent chains must not recurse forever.
     CYCLE ctx SET "isCycle" USING "cyclePath"
     SELECT DISTINCT s.fid::text AS gv, cm."memberId" AS pid
       FROM subtree s JOIN "ContextMembers" cm ON cm."contextId" = s.ctx
      WHERE cm."memberType" = 'Principal' AND cm."memberId" = ANY($2::uuid[])`,
    [frontierIds, pids],
  );
  const gvBy = new Map();
  for (const r of fm) { let a = gvBy.get(r.pid); if (!a) { a = []; gvBy.set(r.pid, a); } a.push(r.gv); }

  const { rows: pt } = await db.query(`SELECT id, "principalType" AS pt FROM "Principals" WHERE id = ANY($1)`, [pids]);
  const isGroup = new Set(pt.filter((r) => r.pt === '#microsoft.graph.group').map((r) => r.id));
  const { rows: nodeMeta } = await db.query(
    `SELECT r.id, r."systemId", s."displayName" AS "systemName"
       FROM "Resources" r LEFT JOIN "Systems" s ON s.id = r."systemId" WHERE r.id = ANY($1)`, [nodeIds]);
  const nodeById = new Map(nodeMeta.map((n) => [n.id, n]));

  const resources = new Map(), cells = new Map(), groupSets = new Map();
  for (const e of rows) {
    if (isGroup.has(e.principalId)) continue;
    const gvs = gvBy.get(e.principalId);
    if (!gvs) continue;
    if (!resources.has(e.resourceId)) {
      const node = nodeById.get(e.nodeId) || {};
      resources.set(e.resourceId, {
        resourceId: e.resourceId, resourceDisplayName: e.displayName,
        resourceType: e.resourceType, resourceDescription: null,
        systemId: node.systemId ?? null, systemName: node.systemName ?? null,
      });
    }
    for (const gv of gvs) {
      let m = cells.get(e.resourceId); if (!m) { m = new Map(); cells.set(e.resourceId, m); }
      let s = m.get(gv); if (!s) { s = new Set(); m.set(gv, s); }
      s.add(e.principalId);
      let gs = groupSets.get(gv); if (!gs) { gs = new Set(); groupSets.set(gv, gs); }
      gs.add(e.principalId);
    }
  }
  if (!resources.size) return null;
  const counts = [];
  for (const [resourceId, m] of cells) for (const [gv, set] of m) counts.push({ resourceId, groupValue: gv, directCount: set.size, governedCount: 0 });
  return {
    resources: [...resources.values()],
    counts,
    groupValues: [...groupSets.keys()],
    groupTotals: [...groupSets.entries()].map(([gv, set]) => ({ groupValue: gv, total: set.size })),
  };
}

// Folded effective counts for the LAYERED ATTRIBUTE FOLD. The group-value of a
// holder is the same collapse-aware tuple key (visibleKeyExpr) the fold uses, so
// the counts land on the existing tuple columns. principal rowType only (the
// tuple is computed on the identity for identity rowType — not yet supported).
export async function buildInheritedFoldCounts(p, built, rowType, sortAttributes, principalCols, collapsed) {
  if (rowType === 'identity') return null;
  if (!built.hasResource || !Array.isArray(sortAttributes) || !sortAttributes.length) return null;
  const nodeIds = await scopedNodeIds(p, built);
  if (!nodeIds.length) return null;
  const eff = await cachedEffectiveAccess(nodeIds);
  if (!eff.length) return null;
  const subjScope = await scopedPrincipalIds(p, built, rowType);
  const rows = subjScope ? eff.filter((e) => subjScope.has(e.principalId)) : eff;
  if (!rows.length) return null;
  const pids = [...new Set(rows.map((r) => r.principalId))];

  const attrExprs = [];
  for (const a of sortAttributes) {
    const r = resolveAttrExpr(a.attribute, 'pr', principalCols);
    if (r.error) return null;
    attrExprs.push(r.attrExpr);
  }
  const coll = Array.isArray(collapsed) ? collapsed : [];
  const placeholders = coll.map((_, i) => `$${i + 2}`);
  const vk = visibleKeyExpr(attrExprs, placeholders);
  const { rows: gvr } = await db.query(
    `SELECT id, ${vk} AS gv FROM "Principals" pr WHERE id = ANY($1)`, [pids, ...coll]);
  const gvBy = new Map(gvr.map((r) => [r.id, r.gv]));

  const { rows: pt } = await db.query(`SELECT id, "principalType" AS pt FROM "Principals" WHERE id = ANY($1)`, [pids]);
  const isGroup = new Set(pt.filter((r) => r.pt === '#microsoft.graph.group').map((r) => r.id));
  const { rows: nodeMeta } = await db.query(
    `SELECT r.id, r."systemId", s."displayName" AS "systemName"
       FROM "Resources" r LEFT JOIN "Systems" s ON s.id = r."systemId" WHERE r.id = ANY($1)`, [nodeIds]);
  const nodeById = new Map(nodeMeta.map((n) => [n.id, n]));

  const resources = new Map(), cells = new Map(), gset = new Set();
  for (const e of rows) {
    if (isGroup.has(e.principalId)) continue;
    const gv = gvBy.get(e.principalId);
    if (gv == null) continue;
    if (!resources.has(e.resourceId)) {
      const node = nodeById.get(e.nodeId) || {};
      resources.set(e.resourceId, {
        resourceId: e.resourceId, resourceDisplayName: e.displayName,
        resourceType: e.resourceType, resourceDescription: null,
        systemId: node.systemId ?? null, systemName: node.systemName ?? null,
      });
    }
    let m = cells.get(e.resourceId); if (!m) { m = new Map(); cells.set(e.resourceId, m); }
    let s = m.get(gv); if (!s) { s = new Set(); m.set(gv, s); }
    s.add(e.principalId);
    gset.add(gv);
  }
  if (!resources.size) return null;
  const counts = [];
  for (const [resourceId, m] of cells) for (const [gv, set] of m) counts.push({ resourceId, groupValue: gv, directCount: set.size, governedCount: 0 });
  return { resources: [...resources.values()], counts, groupValues: [...gset] };
}

// Explain a single inherited cell: "how did this principal get this capability
// at this scope?". Walks the containment chain from the focus node up to the
// root, marking which ancestors actually carry a (capability, principal) grant
// that propagates down — those are the SOURCE(s) of the inheritance. Returns the
// chain (source at top → focus at bottom) for a breadcrumb, plus the source
// rows for the headline ("Owner on Subscription X").
export async function explainInheritance(focusNodeId, capabilityId, principalId) {
  const { rows } = await db.query(
    `WITH RECURSIVE up(id, name, label, depth) AS (
       SELECT id, "displayName", "extendedAttributes" ->> 'scopeTypeLabel', 0
         FROM "Resources" WHERE id = $1
       UNION ALL
       SELECT pr.id, pr."displayName", pr."extendedAttributes" ->> 'scopeTypeLabel', up.depth + 1
         FROM up
         JOIN "ResourceRelationships" rr
           ON rr."childResourceId"::text = up.id::text
          AND rr."relationshipType" = 'Contains'
          AND COALESCE((rr."extendedAttributes" ->> 'propagates')::boolean, true) = true
         JOIN "Resources" pr ON pr.id = rr."parentResourceId"
     )
     SELECT up.id, up.name, up.label, up.depth,
            cap."extendedAttributes" ->> 'roleName' AS rolename,
            ra."effect"            AS effect,
            ra."propagationScope"  AS scope,
            (ra."resourceId" IS NOT NULL) AS "isSource"
       FROM up
       LEFT JOIN "Resources" cap
         ON cap."capabilityId" = $2 AND cap."targetNodeId" = up.id::text
       LEFT JOIN "ResourceAssignments" ra
         ON ra."resourceId" = cap.id AND ra."principalId" = $3
      ORDER BY up.depth ASC`,
    [focusNodeId, capabilityId, principalId],
  );

  const reaches = (r) => r.depth === 0
    ? (!r.scope || r.scope === 'self' || r.scope === 'selfAndDescendants')
    : (!r.scope || r.scope === 'descendants' || r.scope === 'selfAndDescendants');
  const sources = rows.filter((r) => r.isSource && reaches(r));
  const maxDepth = sources.length ? Math.max(...sources.map((s) => s.depth)) : 0;
  const chain = rows
    .filter((r) => r.depth <= maxDepth)
    .map((r) => ({ id: r.id, name: r.name, label: r.label, depth: r.depth, isSource: r.isSource && reaches(r) }))
    .sort((a, b) => b.depth - a.depth); // source (top) → focus (bottom)

  return {
    sources: sources.map((s) => ({ id: s.id, name: s.name, label: s.label, depth: s.depth, role: s.rolename, effect: s.effect })),
    chain,
  };
}
