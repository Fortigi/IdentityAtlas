// The /matrix/data handler — the core matrix query endpoint (flat grid, roll-up,
// context-layered, attribute-fold, and inherited-access modes). Extracted from
// routes/matrix.js as the final slice of the Q1 god-module split, then
// decomposed here: the POST handler is a thin dispatcher that computes the
// shared query context once and hands off to one function per mode. Behaviour
// unchanged — each mode's body is a verbatim move of its original branch.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { timedQuery } from '../../perf/sqlTimer.js';
import { createParams } from '../../db/sqlParams.js';
import { buildIdentityJoinExprs, buildRoleSubjectJoinExprs, buildApMemberExprs, mergeGroupTotals } from '../../db/matrixHelpers.js';
import { resolveAttrExpr } from '../../matrix/attrExpr.js';
import { buildInheritedFlatRows, buildInheritedRollupCounts, buildInheritedContextCounts, buildInheritedFoldCounts } from '../../matrix/inheritedAccess.js';
import {
  isUuid, frontierValues, buildContextRollupSql, buildContextTotalsSql,
  buildContextNodesSql, buildRootChildrenSql, buildContextCutSql,
  buildContextScopedMemberCountsSql,
  buildContextRolesSql, buildContextRolesAsRowsSql,
} from '../../matrix/contextRollup.js';
import { buildAttrCutCellsSql, buildAttrCutNodesSql, tupleToNode } from '../../matrix/attributeCut.js';
import { fetchResourceContexts } from '../../matrix/resourceContexts.js';
import { buildRollupSql, buildRollupRolesSql, buildRolesAsRowsSql, buildGroupTotalsSql, buildRolesDrillSql } from '../../matrix/rollupBuilders.js';
import { parseFilter, buildSubqueries, scopeCounts, runBound, collectResources } from './shared.js';
import { GROUP_PRINCIPAL_TYPE } from '../../lib/principalTypes.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// Shared per-request query context. Every mode below reads the same derived
// subject-column SELECT, subject join, and member expressions off this object,
// so the dispatcher computes them once and passes `ctx` to the chosen handler.
export function buildMatrixContext(filter, built, includeInherited, p) {
  const rowType = filter.rowType;

  // Dynamic subject-column SELECT — pulls every real column of the chosen
  // subject table so the frontend can render attribute columns and
  // tag-filter against them client-side.
  const subjectCols = rowType === 'identity' ? built.identityCols : built.principalCols;
  const subjectAlias = rowType === 'identity' ? 'i' : 'u';
  const dynamicSubjectCols = subjectCols
    .filter(c => !['displayName', 'email'].includes(c.name))
    .map(c => `${subjectAlias}."${c.name}"`)
    .join(',\n        ');

  const subjectJoin = rowType === 'identity'
    ? `INNER JOIN "Principals" u ON p."principalId" = u.id
         INNER JOIN "IdentityMembers" im ON im."principalId" = u.id
         INNER JOIN "Identities" i ON i.id = im."identityId"`
    : `INNER JOIN "Principals" u ON p."principalId" = u.id`;

  const memberIdExpr   = rowType === 'identity' ? 'i.id'             : 'p."principalId"';
  const memberNameExpr = rowType === 'identity' ? 'i."displayName"'  : 'u."displayName"';
  const memberUpnExpr  = rowType === 'identity' ? 'i."email"'        : 'u."email"';
  const memberTypeExpr = rowType === 'identity' ? `'Identity'`       : 'p."principalType"';

  const subjectIdForFilter = rowType === 'identity' ? 'i.id' : 'p."principalId"';

  return {
    filter, built, includeInherited, p, rowType,
    subjectCols, subjectAlias, dynamicSubjectCols, subjectJoin,
    memberIdExpr, memberNameExpr, memberUpnExpr, memberTypeExpr, subjectIdForFilter,
  };
}

// Compute the inherited (effective) attribute-fold counts, normalised so the
// caller needs no null-guards. Returns empty arrays when the opt-in flag is off
// or the effective-access engine fails (recorded as a warning).
async function inheritedAttrFold(ctx) {
  const { filter, built, rowType, includeInherited, p } = ctx;
  if (!includeInherited) return { groupValues: [], resources: [], counts: [] };
  try {
    const inh = await buildInheritedFoldCounts(p, built, rowType, filter.sortAttributes, built.principalCols, filter.rollupCollapsed);
    return { groupValues: inh?.groupValues || [], resources: inh?.resources || [], counts: inh?.counts || [] };
  } catch (err) {
    built.warnings.push('inherited fold failed: ' + err.message);
    return { groupValues: [], resources: [], counts: [] };
  }
}

// ─── Layered ATTRIBUTE fold (server-aggregated, expand-in-place) ───
// The efficient counterpart of the per-subject attribute fold: columns are
// the visible attribute-tuple "cut", each cell a Direct count, expanding a
// tuple into the next attribute's values. Renders through the same layered
// view as Manager Hierarchy. Set by the wizard for matrices too large to
// ship every per-subject row.
async function handleAttributeFold(res, ctx) {
  const { filter, built, rowType, subjectAlias, subjectJoin, memberIdExpr, subjectIdForFilter, p } = ctx;

  const subjCols = rowType === 'identity' ? built.identityCols : built.principalCols;
  const attrExprs = [];
  for (const a of filter.sortAttributes) {
    const resolved = resolveAttrExpr(a.attribute, subjectAlias, subjCols);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    attrExprs.push(resolved.attrExpr);
  }
  if (!attrExprs.length) return res.status(400).json({ error: 'No fold attributes' });

  // COLLAPSE model: nothing folded -> every subject at full depth, so all
  // chosen attributes show as header rows. Folding a group pulls it up.
  const collapsedKeys = filter.rollupCollapsed || [];

  // cells: subject + resource fragments + the collapse keys, all bound through
  // one params array (rendered fresh per query so the $N line up).
  const cellRows = (await runBound(p, `matrix-attrcut-cells[${rowType}]`, res, built,
    ({ subjectSql, resourceSql, bind }) => buildAttrCutCellsSql({
      attrExprs, collapsedParams: collapsedKeys.map(k => bind(k)), subjectJoin,
      subjectIdExpr: memberIdExpr, subjectIdForFilter,
      subjectSql, resourceSql,
    }))).rows;

  const nodeRows = (await runBound(p, `matrix-attrcut-nodes[${rowType}]`, res, built,
    ({ subjectSql, bind }) => buildAttrCutNodesSql({
      attrExprs, collapsedParams: collapsedKeys.map(k => bind(k)),
      subjectTable: rowType === 'identity' ? 'Identities' : 'Principals',
      subjectAlias,
      subjectIdExpr: rowType === 'identity' ? 'i.id' : 'u.id',
      subjectIdForFilter: rowType === 'identity' ? 'i.id' : 'u.id',
      subjectSql,
      excludeGroups: rowType !== 'identity',
    }), { resource: false })).rows;

  // Fold inherited (effective) access into the layered attribute fold. Holder
  // tuple keys match the fold's visible key, so they reuse existing columns.
  const inhFold = await inheritedAttrFold(ctx);

  // Hide attribute groups with no in-scope assignments — a column only shows
  // if some resource has a Direct (or inherited) count for it.
  const attrCellIds = new Set([...cellRows.map(c => c.groupValue), ...inhFold.groupValues]);
  const nodes = nodeRows
    .filter(r => attrCellIds.has(r.groupValue))
    .map(r => tupleToNode(r.groupValue, r.total, r.childCount))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const resMap = collectResources(new Map(), cellRows);
  collectResources(resMap, inhFold.resources, r => r);

  const counts = await scopeCounts(p, res, rowType, built);
  // Always show one header row per chosen attribute (folded groups occupy
  // their level and a "folded" cell below), so the structure is visible even
  // when collapsed — unlike the dynamic-depth Manager-Hierarchy view.
  const maxDepth = attrExprs.length;
  return res.json({
    rollup: 'context', rollupKind: 'context', layered: true, layeredAttributes: true,
    rollupContent: 'resources-only', rollupMetric: filter.rollupMetric, rowType, maxDepth,
    nodes,
    groupValues: nodes.map(n => n.id),
    groupTotals: nodes.map(n => ({ groupValue: n.id, total: n.total })),
    resources: [...resMap.values()],
    counts: [
      ...cellRows.map(r => ({
        resourceId: r.resourceId, groupValue: r.groupValue,
        directCount: r.directCount, governedCount: r.governedCount,
      })),
      ...inhFold.counts,
    ],
    ...counts, totalUsers: counts.subjectTotal, warnings: built.warnings,
  });
}

// ─── EXPERIMENTAL: context-tree roll-up ───
// Columns are the context nodes of the current frontier (a cut of the tree);
// each cell counts the in-scope subjects in that node's whole subtree with a
// Direct assignment. Drilling replaces a node with its children (handled by
// the frontend re-sending a new frontier).
async function handleContextRollup(res, ctx) {
  const { filter } = ctx;
  if (!isUuid(filter.rollupContextId)) return res.status(400).json({ error: 'Invalid context id' });

  if (filter.sortHierarchy) return handleContextLayered(res, ctx);
  return handleContextZoom(res, ctx);
}

// Fold inherited (effective) context counts into a layered/zoom view: merges any
// new holder resources into `resMap`, and returns the per-node inherited totals,
// the set of node ids with any (declared or inherited) cell, and the extra
// counts — all null-guarded so the caller stays flat. `nodeIds` are the nodes
// the engine should compute effective access at.
async function inheritedLayerFold(ctx, nodeIds, cells, resMap) {
  const { built, rowType, includeInherited, p } = ctx;
  let inhCtx = null;
  if (includeInherited) {
    try { inhCtx = await buildInheritedContextCounts(p, built, rowType, nodeIds); }
    catch (err) { built.warnings.push('inherited context fold failed: ' + err.message); }
  }
  const inhTotByNode = new Map((inhCtx?.groupTotals || []).map(t => [t.groupValue, t.total]));
  collectResources(resMap, inhCtx?.resources, r => r);
  const cellNodeIds = new Set([...cells.map(c => c.groupValue), ...(inhCtx?.groupValues || [])]);
  return { inhTotByNode, cellNodeIds, counts: inhCtx?.counts || [] };
}

// ─── Layered hierarchy view (Manager-Hierarchy sort) ───
// Show the tree as stacked, expand-in-place header rows instead of the
// one-level-at-a-time zoom. The visible columns are the current cut: the
// root's children, with every expanded node replaced by its children. Each
// column carries its ancestor path so the frontend renders one merged
// header row per level; cells count the node's whole subtree (resources on
// the rows). Expanding a node adds the next level as a new header row.
async function handleContextLayered(res, ctx) {
  const { filter, built, rowType, p } = ctx;

  const expandedIds = (filter.rollupExpanded || []).filter(isUuid);
  let cutNodes;
  try {
    cutNodes = (await timedQuery(p, 'matrix-ctx-cut', res, buildContextCutSql(filter.rollupContextId, expandedIds), [])).rows;
  } catch { return res.status(400).json({ error: 'Invalid hierarchy' }); }

  let frontier = cutNodes.map(n => n.id);
  if (frontier.length === 0) frontier = [filter.rollupContextId]; // root is a leaf

  let cutValues;
  try { cutValues = frontierValues(frontier); }
  catch { return res.status(400).json({ error: 'Invalid frontier' }); }

  const { join: idJoin, subjectId: cutSubjectId } = buildIdentityJoinExprs(rowType);

  const layerCells = (await runBound(p, `matrix-ctx-layered[${rowType}]`, res, built,
    ({ subjectSql, resourceSql }) => buildContextRollupSql({
      values: cutValues, identityJoin: idJoin, subjectId: cutSubjectId, subjectScope: cutSubjectId,
      subjectSql, resourceSql,
    }))).rows;

  const layerResMap = collectResources(new Map(), layerCells);

  // SCOPED member counts for the header (direct / total), so they match the
  // assignment-scoped cells and member drill rather than raw org size.
  const scMap = new Map((await runBound(p, `matrix-ctx-scoped-members[${rowType}]`, res, built,
    ({ subjectSql, resourceSql }) => buildContextScopedMemberCountsSql({
      values: cutValues, identityJoin: idJoin, subjectId: cutSubjectId, subjectScope: cutSubjectId,
      subjectSql, resourceSql,
    }))).rows.map(r => [r.groupValue, { total: r.total, direct: r.direct }]));

  // Fold inherited (effective) access into the org-rollup cells; hides org
  // branches with no in-scope assignments (a column only shows if some resource
  // has a Direct or inherited count for that node's subtree).
  const { inhTotByNode, cellNodeIds, counts: inhCounts } =
    await inheritedLayerFold(ctx, cutNodes.map(n => n.id), layerCells, layerResMap);
  const visibleNodes = cutNodes
    .filter(n => cellNodeIds.has(n.id))
    .map(n => {
      const sc = scMap.get(n.id);
      const inhT = inhTotByNode.get(n.id) || 0;
      if (sc) return { ...n, total: sc.total + inhT, directMembers: sc.direct };
      if (inhT) return { ...n, total: inhT, directMembers: 0 };
      return n;
    });

  const layerCounts = await scopeCounts(p, res, rowType, built);
  const maxDepth = visibleNodes.reduce((m, n) => Math.max(m, n.depth || 1), 1);
  return res.json({
    rollup: 'context', rollupKind: 'context', layered: true,
    rollupContextId: filter.rollupContextId, rollupContent: 'resources-only',
    rollupMetric: filter.rollupMetric, rowType, maxDepth,
    nodes: visibleNodes,
    groupValues: visibleNodes.map(n => n.id),
    groupTotals: visibleNodes.map(n => ({ groupValue: n.id, total: n.total })),
    resources: [...layerResMap.values()],
    counts: [
      ...layerCells.map(r => ({
        resourceId: r.resourceId, groupValue: r.groupValue,
        directCount: r.directCount, governedCount: r.governedCount,
      })),
      ...inhCounts,
    ],
    ...layerCounts, totalUsers: layerCounts.subjectTotal, warnings: built.warnings,
  });
}

// The view zooms one level at a time. focus = the node we're zoomed into
// (the last step of the drill path, or the root). Columns = the focus
// node's children; the breadcrumb is root → … → focus.
async function handleContextZoom(res, ctx) {
  const { filter, built, rowType, p } = ctx;

  const path = filter.rollupPath.filter(isUuid);
  const focus = path.length ? path[path.length - 1] : filter.rollupContextId;

  let frontier = (await timedQuery(p, 'matrix-ctx-focus-children', res, buildRootChildrenSql(focus), [])).rows.map(r => r.id);
  if (frontier.length === 0) frontier = [focus]; // leaf focus — show it as the single column

  let values;
  try { values = frontierValues(frontier); }
  catch { return res.status(400).json({ error: 'Invalid frontier' }); }

  const { join: identityJoin, subjectId: ctxSubjectId } = buildIdentityJoinExprs(rowType);

  // Roles-only leaf drill: expand one org (already scoped via a subject
  // context condition) into its subjects + the business role each holds.
  if (filter.drill) {
    const { join: brSubjectJoin, id: brId, name: brName, type: brType } = buildRoleSubjectJoinExprs(rowType);
    const members = (await runBound(p, `matrix-ctx-rows-drill[${rowType}]`, res, built,
      ({ subjectSql }) => buildRolesDrillSql({
        subjectJoin: brSubjectJoin, subjectIdExpr: brId,
        subjectNameExpr: brName,
        subjectTypeExpr: brType,
        subjectIdForFilter: brId, subjectSql,
      }), { resource: false })).rows;
    return res.json({ rollup: 'context', rollupKind: 'context', rollupContent: 'roles-only', drill: { members } });
  }

  // Shared: per-node subject totals (% denominator), node metadata, breadcrumb.
  const ctxTotals = (await runBound(p, `matrix-ctx-totals[${rowType}]`, res, built,
    ({ subjectSql }) => buildContextTotalsSql({
      values, identityJoin, subjectId: ctxSubjectId, subjectScope: ctxSubjectId,
      subjectSql,
    }), { resource: false })).rows.map(r => ({ groupValue: r.groupValue, total: r.total }));

  const nodeRows = (await timedQuery(p, 'matrix-ctx-nodes', res, buildContextNodesSql(frontier), [])).rows;
  const nodeMeta = new Map(nodeRows.map(n => [n.id, { id: n.id, displayName: n.displayName, parent: n.parent, total: n.total, directMembers: n.directMembers, childCount: n.childCount }]));
  const orderedFrontier = [...frontier].sort((a, b) => (nodeMeta.get(b)?.total || 0) - (nodeMeta.get(a)?.total || 0));

  const crumbIds = [filter.rollupContextId, ...path];
  const crumbRows = (await timedQuery(p, 'matrix-ctx-crumbs', res, buildContextNodesSql(crumbIds), [])).rows;
  const crumbMeta = new Map(crumbRows.map(c => [c.id, c.displayName]));
  const breadcrumb = crumbIds.map(id => ({ id, displayName: crumbMeta.get(id) || id }));

  const counts = await scopeCounts(p, res, rowType, built);
  const shared = {
    rollup: 'context', rollupKind: 'context',
    rollupContextId: filter.rollupContextId, rollupContent: filter.rollupContent,
    rollupMetric: filter.rollupMetric, focusId: focus, breadcrumb, rowType,
    groupValues: orderedFrontier,
    nodes: orderedFrontier.map(id => nodeMeta.get(id) || { id, displayName: id, parent: null, total: 0, directMembers: 0, childCount: 0 }),
    groupTotals: ctxTotals,
    ...counts, totalUsers: counts.subjectTotal, warnings: built.warnings,
  };

  const z = { values, identityJoin, ctxSubjectId, frontier, ctxTotals, shared };
  if (filter.rollupContent === 'roles-only') return handleContextZoomRoles(res, ctx, z);
  return handleContextZoomResources(res, ctx, z);
}

// ── Business roles on the rows (org units stay on the columns) ──
async function handleContextZoomRoles(res, ctx, z) {
  const { built, rowType, p } = ctx;
  const { values, identityJoin, ctxSubjectId, shared } = z;

  const roleRowsRes = (await runBound(p, `matrix-ctx-roles-rows[${rowType}]`, res, built,
    ({ subjectSql }) => buildContextRolesAsRowsSql({
      values, identityJoin, subjectId: ctxSubjectId, subjectScope: ctxSubjectId,
      subjectSql,
    }), { resource: false })).rows;
  const roleMap = new Map();
  for (const r of roleRowsRes) {
    if (!r.roleId) continue;
    if (!roleMap.has(r.roleId)) roleMap.set(r.roleId, { id: r.roleId, displayName: r.roleName || r.roleId, description: r.roleDescription || '' });
  }
  return res.json({
    ...shared,
    roleRows: [...roleMap.values()],
    cells: roleRowsRes.filter(r => r.roleId).map(r => ({ roleId: r.roleId, groupValue: r.groupValue, count: r.count })),
  });
}

// SOLL (business-role) count columns for the context-zoom resource view.
// Returns { businessRoles, roleCounts }; tolerates the business-role view being
// absent (returns whatever was collected before any failure).
async function contextZoomBusinessRoles(res, ctx, z) {
  const { built, rowType, p } = ctx;
  const { values, identityJoin, ctxSubjectId } = z;
  const roleCounts = [];
  try {
    const brRows = (await runBound(p, `matrix-ctx-roles[${rowType}]`, res, built,
      ({ subjectSql, resourceSql }) => buildContextRolesSql({
        values, identityJoin, subjectId: ctxSubjectId, subjectScope: ctxSubjectId,
        subjectSql, resourceSql,
      }))).rows;
    const roleMap = new Map();
    for (const r of brRows) {
      if (!r.roleId) continue;
      if (!roleMap.has(r.roleId)) roleMap.set(r.roleId, { id: r.roleId, displayName: r.roleName || r.roleId });
      roleCounts.push({ resourceId: r.resourceId, roleId: r.roleId, count: r.count });
    }
    const businessRoles = [...roleMap.values()].sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    return { businessRoles, roleCounts };
  } catch { return { businessRoles: [], roleCounts }; }
}

// ── Resources on the rows (+ optional business-role count columns) ──
async function handleContextZoomResources(res, ctx, z) {
  const { filter, built, rowType, includeInherited, p } = ctx;
  const { values, identityJoin, ctxSubjectId, frontier, ctxTotals, shared } = z;

  const cellRows = (await runBound(p, `matrix-ctx-rollup[${rowType}]`, res, built,
    ({ subjectSql, resourceSql }) => buildContextRollupSql({
      values, identityJoin, subjectId: ctxSubjectId, subjectScope: ctxSubjectId,
      subjectSql, resourceSql,
    }))).rows;

  const resMap = collectResources(new Map(), cellRows);

  // Fold inherited (effective) access into the org-rollup cells (zoom view).
  // The frontier columns already exist, so we only add resources + counts.
  let inhCtx2 = null;
  if (includeInherited) {
    try { inhCtx2 = await buildInheritedContextCounts(p, built, rowType, frontier); }
    catch (err) { built.warnings.push('inherited context fold failed: ' + err.message); }
  }
  collectResources(resMap, inhCtx2?.resources, r => r);

  let businessRoles = [];
  let roleCounts = [];
  if (filter.rollupContent !== 'resources-only') {
    ({ businessRoles, roleCounts } = await contextZoomBusinessRoles(res, ctx, z));
  }

  const mergedCtxTotals = mergeGroupTotals(ctxTotals, inhCtx2?.groupTotals);

  return res.json({
    ...shared,
    groupTotals: mergedCtxTotals,
    resources: [...resMap.values()],
    counts: [
      ...cellRows.map(r => ({
        resourceId: r.resourceId, groupValue: r.groupValue,
        directCount: r.directCount, governedCount: r.governedCount,
      })),
      ...(inhCtx2?.counts || []),
    ],
    businessRoles,
    roleCounts,
  });
}

// ─── Roll-up aggregation branch ───
// Columns become distinct values of `filter.rollup`; each cell is the count
// of distinct subjects with a Direct assignment. Compact payload, so the
// wizard's 25k "too large" guard doesn't apply.
async function handleRollup(res, ctx) {
  const { filter, built, rowType, subjectAlias, p } = ctx;

  const subjCols = rowType === 'identity' ? built.identityCols : built.principalCols;
  const resolved = resolveAttrExpr(filter.rollup, subjectAlias, subjCols);
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  // Per-group subject denominator for the "% of subjects" metric. Returned
  // in every roll-up response so the frontend can switch count↔percent
  // without a re-query.
  const groupTotals = (await runBound(p, `matrix-rollup-totals[${rowType}]`, res, built,
    ({ subjectSql }) => buildGroupTotalsSql({
      attrExpr: resolved.attrExpr,
      subjectTable: rowType === 'identity' ? 'Identities' : 'Principals',
      subjectAlias,
      subjectSql,
    }), { resource: false })).rows.map(r => ({ groupValue: r.groupValue, total: r.total }));

  if (filter.rollupContent === 'roles-only') return handleRollupRoles(res, ctx, resolved, groupTotals);
  return handleRollupResources(res, ctx, resolved, groupTotals);
}

// ─── Business roles as rows ───
async function handleRollupRoles(res, ctx, resolved, groupTotals) {
  const { filter, built, rowType, p } = ctx;

  const { join: brSubjectJoin, id: brSubjectId, name: brSubjectName, type: brSubjectType } = buildRoleSubjectJoinExprs(rowType);

  // Drill-down: expand one group column into its individual subjects +
  // which business role each holds. The group is already scoped via a
  // subject attribute condition the frontend added, so subjectSql carries
  // the constraint. Returns a compact { members } payload only.
  if (filter.drill) {
    const members = (await runBound(p, `matrix-rollup-rows-drill[${rowType}]`, res, built,
      ({ subjectSql }) => buildRolesDrillSql({
        subjectJoin: brSubjectJoin,
        subjectIdExpr: brSubjectId,
        subjectNameExpr: brSubjectName,
        subjectTypeExpr: brSubjectType,
        subjectIdForFilter: brSubjectId,
        subjectSql,
      }), { resource: false })).rows;
    return res.json({ rollup: filter.rollup, rollupContent: 'roles-only', drill: { members } });
  }

  const rolesResult = (await runBound(p, `matrix-rollup-rows[${rowType}]`, res, built,
    ({ subjectSql }) => buildRolesAsRowsSql({
      attrExpr: resolved.attrExpr,
      subjectJoin: brSubjectJoin,
      subjectIdExpr: brSubjectId,
      subjectIdForFilter: brSubjectId,
      subjectSql,
    }), { resource: false })).rows;

  const counts = await scopeCounts(p, res, rowType, built);
  const roleMap = new Map();
  const groupSet = new Set();
  for (const row of rolesResult) {
    if (!row.roleId) continue;
    if (!roleMap.has(row.roleId)) {
      roleMap.set(row.roleId, { id: row.roleId, displayName: row.roleName || row.roleId, description: row.roleDescription || '' });
    }
    groupSet.add(row.groupValue);
  }
  return res.json({
    rollup: filter.rollup,
    rollupContent: 'roles-only',
    rowType,
    groupValues: [...groupSet].sort((a, b) => String(a).localeCompare(String(b))),
    groupTotals,
    roleRows: [...roleMap.values()],
    cells: rolesResult.filter(r => r.roleId).map(r => ({ roleId: r.roleId, groupValue: r.groupValue, count: r.count })),
    ...counts,
    totalUsers: counts.subjectTotal,
    warnings: built.warnings,
  });
}

// Fold inherited (effective) access into the rollup — mutates resMap/groupSet
// and returns the inherited counts + group totals.
async function foldInheritedRollupCounts(p, built, rowType, filter, resMap, groupSet) {
  let inhCounts = [];
  let inhGroupTotals = [];
  try {
    const inh = await buildInheritedRollupCounts(p, built, rowType, filter.rollup, built.principalCols);
    if (inh) {
      collectResources(resMap, inh.resources, r => r);
      for (const gv of inh.groupValues) groupSet.add(gv);
      inhCounts = inh.counts;
      inhGroupTotals = inh.groupTotals;
    }
  } catch (err) { built.warnings.push('inherited rollup fold failed: ' + err.message); }
  return { inhCounts, inhGroupTotals };
}

// Business-role (SOLL) counts per resource. Empty when rollupContent is
// resources-only or the business-role view is absent.
async function fetchRollupRoleCounts(res, built, rowType, filter, p) {
  if (filter.rollupContent === 'resources-only') return { businessRoles: [], roleCounts: [] };
  const roleCounts = [];
  let businessRoles = [];
  try {
    const { memberId: brMemberId, join: brJoin } = buildApMemberExprs(rowType);
    const brRows = (await runBound(p, 'matrix-rollup-roles', res, built,
      ({ subjectSql, resourceSql }) => buildRollupRolesSql({ brMemberId, brJoin, subjectSql, resourceSql }))).rows;
    const roleMap = new Map();
    for (const r of brRows) {
      if (!r.roleId) continue;
      if (!roleMap.has(r.roleId)) roleMap.set(r.roleId, { id: r.roleId, displayName: r.roleName || r.roleId });
      roleCounts.push({ resourceId: r.resourceId, roleId: r.roleId, count: r.count });
    }
    businessRoles = [...roleMap.values()].sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  } catch { /* business-role view may be absent */ }
  return { businessRoles, roleCounts };
}

// Fold inherited (effective) flat rows into `rows` — declared wins on collision.
async function foldInheritedFlatAccess(p, built, rowType, subjectCols, rows) {
  try {
    const effFlat = await buildInheritedFlatRows(p, built, rowType, subjectCols);
    const seen = new Set(rows.map((r) => `${r.resourceId}|${r.memberId}`));
    for (const er of effFlat) {
      const k = `${er.resourceId}|${er.memberId}`;
      if (!seen.has(k)) { seen.add(k); rows.push(er); } // declared wins
    }
  } catch (err) {
    built.warnings.push('inherited-access fold failed: ' + err.message);
  }
}

// ─── Resources as rows (+ optional business-role count columns) ───
async function handleRollupResources(res, ctx, resolved, groupTotals) {
  const { filter, built, rowType, subjectJoin, memberIdExpr, subjectIdForFilter, includeInherited, p } = ctx;

  const rollupResult = await runBound(p, `matrix-rollup[${rowType}]`, res, built,
    ({ subjectSql, resourceSql }) => buildRollupSql({
      attrExpr: resolved.attrExpr,
      subjectJoin,
      subjectIdExpr: memberIdExpr,
      subjectIdForFilter,
      subjectSql,
      resourceSql,
    }));

  const counts = await scopeCounts(p, res, rowType, built);
  const resMap = collectResources(new Map(), rollupResult.rows);
  const groupSet = new Set(rollupResult.rows.map(r => r.groupValue));

  // Fold inherited (effective) access into the count cells (Phase 2) — the
  // declared rollup is empty for scope-node scopes.
  let inhCounts = [];
  let inhGroupTotals = [];
  if (includeInherited) {
    ({ inhCounts, inhGroupTotals } = await foldInheritedRollupCounts(p, built, rowType, filter, resMap, groupSet));
  }

  // Business-role (SOLL) counts per resource (mirrors the SOLL columns, aggregated).
  const { businessRoles, roleCounts } = await fetchRollupRoleCounts(res, built, rowType, filter, p);

  const mergedGroupTotals = mergeGroupTotals(groupTotals, inhGroupTotals);

  return res.json({
    rollup: filter.rollup,
    rollupContent: filter.rollupContent,
    rowType,
    resources: [...resMap.values()],
    groupValues: [...groupSet].sort((a, b) => String(a).localeCompare(String(b))),
    groupTotals: mergedGroupTotals,
    counts: [
      ...rollupResult.rows.map(r => ({
        resourceId: r.resourceId, groupValue: r.groupValue,
        directCount: r.directCount, governedCount: r.governedCount,
      })),
      ...inhCounts,
    ],
    businessRoles,
    roleCounts,
    ...counts,
    totalUsers: counts.subjectTotal,
    warnings: built.warnings,
  });
}

// ─── Flat per-subject grid (default) ───
// Every in-scope (subject, resource) assignment as its own row. The heaviest
// payload; guarded by MAX_FLAT_ROWS below.
async function handleFlatGrid(res, ctx) {
  const {
    built, rowType, subjectCols, subjectAlias, dynamicSubjectCols,
    subjectJoin, memberIdExpr, memberNameExpr, memberUpnExpr, memberTypeExpr,
    subjectIdForFilter, includeInherited, p,
  } = ctx;

  const { params, bind } = createParams();
  const flatSubjectSql = built.subject(bind).sql;
  const flatResourceSql = built.resource(bind).sql;

  const where = [`(p."principalType" IS NULL OR p."principalType" != '${GROUP_PRINCIPAL_TYPE}')`];
  if (flatSubjectSql)  where.push(`${subjectIdForFilter} IN ${flatSubjectSql}`);
  if (flatResourceSql) where.push(`p."resourceId" IN ${flatResourceSql}`);

  // DISTINCT collapses the cross product when one identity has many
  // principals → many duplicate matrix rows. No-op for rowType=principal.
  const distinct = rowType === 'identity' ? 'DISTINCT' : '';

  const dataSql = `
      SELECT ${distinct}
        p."resourceId" AS "resourceId",
        p."resourceId" AS "groupId",
        r."displayName" AS "resourceDisplayName",
        r."displayName" AS "groupDisplayName",
        r."resourceType",
        r."resourceType" AS "groupTypeCalculated",
        r."description" AS "resourceDescription",
        r."description" AS "groupDescription",
        r."systemId",
        sys."displayName" AS "systemName",
        ${memberIdExpr}   AS "memberId",
        ${memberNameExpr} AS "memberDisplayName",
        ${memberUpnExpr}  AS "memberUPN",
        ${memberTypeExpr} AS "memberType",
        p."membershipType",
        ${dynamicSubjectCols ? dynamicSubjectCols + ',' : ''}
        ${subjectAlias}."extendedAttributes" AS "extendedAttributes",
        p."managedByAccessPackage"
      FROM "vw_ResourceUserPermissionAssignments" p
      ${subjectJoin}
      LEFT JOIN "Resources" r ON p."resourceId" = r.id
      LEFT JOIN "Systems" sys ON r."systemId" = sys.id
      WHERE ${where.join(' AND ')}
    `;
  const result = await timedQuery(p, `matrix-data[${rowType}]`, res, dataSql, params);

  // Additive inherited (effective) access fold — empty for non-scope scopes.
  if (includeInherited) {
    await foldInheritedFlatAccess(p, built, rowType, subjectCols, result.rows);
  }

  // Backstop: a flat per-subject grid serializes every assignment row into one
  // JSON string. Past ~half a million rows that string can exceed V8's max
  // length (RangeError: Invalid string length) and crash the response. Fail
  // cleanly with guidance toward the aggregated views instead.
  const MAX_FLAT_ROWS = 400_000;
  if (result.rows.length > MAX_FLAT_ROWS) {
    return res.status(413).json({
      error: `This matrix has ${result.rows.length.toLocaleString()} assignments — too many to load as a per-subject grid. Sort by Manager Hierarchy or roll up by an attribute (both aggregate on the server), or add filters to narrow it.`,
    });
  }

  const { subjectCount, subjectTotal, resourceCount, resourceTotal } = await scopeCounts(p, res, rowType, built);

  // AP mapping — keyed by memberId (principal or identity depending on
  // rowType) so the existing frontend renders SOLL columns correctly.
  let managedByPackages = [];
  try {
    const app = createParams();
    const apSubjectSql = built.subject(app.bind).sql;
    const apResourceSql = built.resource(app.bind).sql;

    const apMemberIdExpr = rowType === 'identity'
      ? 'im2."identityId"'
      : 'ap."userId"';
    const apJoin = rowType === 'identity'
      ? `INNER JOIN "IdentityMembers" im2 ON im2."principalId" = ap."userId"`
      : '';
    const apWhere = [];
    if (apSubjectSql)  apWhere.push(`${apMemberIdExpr} IN ${apSubjectSql}`);
    if (apResourceSql) apWhere.push(`ap."resourceId" IN ${apResourceSql}`);

    const apResult = await timedQuery(p, 'matrix-data-ap-mapping', res, `
        SELECT ${apMemberIdExpr} AS "memberId",
               ap."resourceId" AS "resourceId",
               ap."resourceId" AS "groupId",
               string_agg(DISTINCT ap."businessRoleId"::text, ',') AS "accessPackageIds"
          FROM "vw_UserPermissionAssignmentViaBusinessRole" ap
          ${apJoin}
          ${apWhere.length ? 'WHERE ' + apWhere.join(' AND ') : ''}
          GROUP BY ${apMemberIdExpr}, ap."resourceId"
      `, app.params);
    managedByPackages = apResult.rows
      .filter(r => r.memberId)
      .map(r => ({
        memberId: r.memberId,
        resourceId: r.resourceId || r.groupId,
        groupId: r.groupId || r.resourceId,
        accessPackageIds: r.accessPackageIds ? r.accessPackageIds.split(',') : [],
      }));
  } catch { /* AP view may not exist */ }

  // Contexts sidecar — the Contexts each visible resource belongs to, so the
  // grid can show them as a right-side metadata column without a per-row fetch.
  const resourceContexts = await fetchResourceContexts(p, res, result.rows.map(r => r.resourceId));

  return res.json({
    data: result.rows,
    rowType,
    subjectCount,
    subjectTotal,
    resourceCount,
    resourceTotal,
    // Backward-compat alias used by the existing matrix toolbar footer.
    totalUsers: subjectTotal,
    managedByPackages,
    resourceContexts,
    warnings: built.warnings,
  });
}

router.post('/matrix/data', async (req, res) => {
  if (!useSql) {
    return res.json({
      data: [], rowType: 'principal', managedByPackages: [], resourceContexts: [],
      subjectCount: 0, subjectTotal: 0, resourceCount: 0, resourceTotal: 0, assignmentCount: 0,
    });
  }
  const filter = parseFilter(req.body);
  if (!filter) return res.status(400).json({ error: 'Invalid filter body' });
  // Opt-in: fold access inherited from higher scopes (Owner@subscription ⇒
  // Indirect on resources beneath) into the result, computed on demand by the
  // effective-access engine. Bounded-scope only (see inheritedAccess.js).
  const includeInherited = req.body?.includeInheritedAccess === true
    || req.body?.filter?.includeInheritedAccess === true;

  // Manager-Hierarchy sort is served as a context roll-up: aggregate per org
  // node on the server rather than ship every per-subject row (which overflows
  // JSON serialization for large subject sets). The wizard still presents it as
  // a sort; rollupPath (set by RollupMatrixView as you zoom in) carries the
  // drill state. Member drill-downs clear sortHierarchy to get the flat rows.
  if (filter.sortHierarchy && filter.rollupKind !== 'context' && !filter.rollup) {
    filter.rollupKind = 'context';
    filter.rollupContextId = filter.sortHierarchy.contextId;
    filter.rollupContent = 'resources-only';
  }

  try {
    const built = await buildSubqueries(filter);
    const p = await db.getPool();
    const ctx = buildMatrixContext(filter, built, includeInherited, p);

    // Dispatch to the matching mode. Order matters: attribute-fold and
    // context roll-up pre-empt the plain roll-up and flat-grid paths.
    if (filter.foldAttributes && !filter.rollup && filter.rollupKind !== 'context')
      return await handleAttributeFold(res, ctx);
    if (filter.rollupKind === 'context' && filter.rollupContextId)
      return await handleContextRollup(res, ctx);
    if (filter.rollup)
      return await handleRollup(res, ctx);
    return await handleFlatGrid(res, ctx);
  } catch (err) {
    console.error('matrix/data failed:', err.message, '\nStack:', err.stack);
    return res.status(500).json({ error: 'Matrix query failed' });
  }
});

export default router;
