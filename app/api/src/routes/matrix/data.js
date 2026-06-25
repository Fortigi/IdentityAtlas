// The /matrix/data handler — the core matrix query endpoint (flat grid, roll-up,
// context-layered, attribute-fold, and inherited-access modes). Extracted from
// routes/matrix.js as the final slice of the Q1 god-module split. Behaviour
// unchanged — verbatim move; matrix.js mounts this router via router.use().

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { timedRequest } from '../../perf/sqlTimer.js';
import { buildIdentityJoinExprs, buildRoleSubjectJoinExprs, buildApMemberExprs, mergeGroupTotals, resourceMeta } from '../../db/matrixHelpers.js';
import { resolveAttrExpr } from '../../matrix/attrExpr.js';
import { buildInheritedFlatRows, buildInheritedRollupCounts, buildInheritedContextCounts, buildInheritedFoldCounts } from '../../matrix/inheritedAccess.js';
import {
  isUuid, frontierValues, buildContextRollupSql, buildContextTotalsSql,
  buildContextNodesSql, buildRootChildrenSql, buildContextCutSql,
  buildContextScopedMemberCountsSql,
  buildContextRolesSql, buildContextRolesAsRowsSql,
} from '../../matrix/contextRollup.js';
import { buildAttrCutCellsSql, buildAttrCutNodesSql, tupleToNode } from '../../matrix/attributeCut.js';
import { buildRollupSql, buildRollupRolesSql, buildRolesAsRowsSql, buildGroupTotalsSql, buildRolesDrillSql } from '../../matrix/rollupBuilders.js';
import { parseFilter, buildSubqueries, scopeCounts } from './shared.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

router.post('/matrix/data', async (req, res) => {
  if (!useSql) {
    return res.json({
      data: [], rowType: 'principal', managedByPackages: [],
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
    const rowType = filter.rowType;
    const p = await db.getPool();

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

    // ─── Layered ATTRIBUTE fold (server-aggregated, expand-in-place) ───
    // The efficient counterpart of the per-subject attribute fold: columns are
    // the visible attribute-tuple "cut", each cell a Direct count, expanding a
    // tuple into the next attribute's values. Renders through the same layered
    // view as Manager Hierarchy. Set by the wizard for matrices too large to
    // ship every per-subject row.
    if (filter.foldAttributes && !filter.rollup && filter.rollupKind !== 'context') {
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
      const collapsedParams = collapsedKeys.map((_, i) => `@col${i}`);
      const bindCollapsed = (req) => collapsedKeys.forEach((kk, i) => req.input(`col${i}`, kk));

      const cellsReq = timedRequest(p, `matrix-attrcut-cells[${rowType}]`, res);
      for (const [k, v] of Object.entries(built.bindings)) cellsReq.input(k, v);
      bindCollapsed(cellsReq);
      const cellRows = (await cellsReq.query(buildAttrCutCellsSql({
        attrExprs, collapsedParams, subjectJoin,
        subjectIdExpr: memberIdExpr, subjectIdForFilter,
        subjectSql: built.subjectSql, resourceSql: built.resourceSql,
      }))).recordset;

      const nodesReq = timedRequest(p, `matrix-attrcut-nodes[${rowType}]`, res);
      for (const [k, v] of Object.entries(built.bindings)) nodesReq.input(k, v);
      bindCollapsed(nodesReq);
      const nodeRows = (await nodesReq.query(buildAttrCutNodesSql({
        attrExprs, collapsedParams,
        subjectTable: rowType === 'identity' ? 'Identities' : 'Principals',
        subjectAlias,
        subjectIdExpr: rowType === 'identity' ? 'i.id' : 'u.id',
        subjectIdForFilter: rowType === 'identity' ? 'i.id' : 'u.id',
        subjectSql: built.subjectSql,
        excludeGroups: rowType !== 'identity',
      }))).recordset;

      // Fold inherited (effective) access into the layered attribute fold. Holder
      // tuple keys match the fold's visible key, so they reuse existing columns.
      let inhFold = null;
      if (includeInherited) {
        try { inhFold = await buildInheritedFoldCounts(p, built, rowType, filter.sortAttributes, built.principalCols, filter.rollupCollapsed); }
        catch (err) { built.warnings.push('inherited fold failed: ' + err.message); }
      }

      // Hide attribute groups with no in-scope assignments — a column only shows
      // if some resource has a Direct (or inherited) count for it.
      const attrCellIds = new Set([...cellRows.map(c => c.groupValue), ...(inhFold?.groupValues || [])]);
      const nodes = nodeRows
        .filter(r => attrCellIds.has(r.groupValue))
        .map(r => tupleToNode(r.groupValue, r.total, r.childCount))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      const resMap = new Map();
      for (const row of cellRows) {
        if (!row.resourceId || resMap.has(row.resourceId)) continue;
        resMap.set(row.resourceId, resourceMeta(row));
      }
      for (const r of (inhFold?.resources || [])) if (!resMap.has(r.resourceId)) resMap.set(r.resourceId, r);

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
          ...(inhFold?.counts || []),
        ],
        ...counts, totalUsers: counts.subjectTotal, warnings: built.warnings,
      });
    }

    // ─── EXPERIMENTAL: context-tree roll-up ───
    // Columns are the context nodes of the current frontier (a cut of the tree);
    // each cell counts the in-scope subjects in that node's whole subtree with a
    // Direct assignment. Drilling replaces a node with its children (handled by
    // the frontend re-sending a new frontier).
    if (filter.rollupKind === 'context' && filter.rollupContextId) {
      if (!isUuid(filter.rollupContextId)) return res.status(400).json({ error: 'Invalid context id' });

      // ─── Layered hierarchy view (Manager-Hierarchy sort) ───
      // Show the tree as stacked, expand-in-place header rows instead of the
      // one-level-at-a-time zoom. The visible columns are the current cut: the
      // root's children, with every expanded node replaced by its children. Each
      // column carries its ancestor path so the frontend renders one merged
      // header row per level; cells count the node's whole subtree (resources on
      // the rows). Expanding a node adds the next level as a new header row.
      if (filter.sortHierarchy) {
        const expandedIds = (filter.rollupExpanded || []).filter(isUuid);
        let cutNodes;
        try {
          const cutReq = timedRequest(p, 'matrix-ctx-cut', res);
          cutNodes = (await cutReq.query(buildContextCutSql(filter.rollupContextId, expandedIds))).recordset;
        } catch { return res.status(400).json({ error: 'Invalid hierarchy' }); }

        let frontier = cutNodes.map(n => n.id);
        if (frontier.length === 0) frontier = [filter.rollupContextId]; // root is a leaf

        let cutValues;
        try { cutValues = frontierValues(frontier); }
        catch { return res.status(400).json({ error: 'Invalid frontier' }); }

        const { join: idJoin, subjectId: cutSubjectId } = buildIdentityJoinExprs(rowType);

        const layerReq = timedRequest(p, `matrix-ctx-layered[${rowType}]`, res);
        for (const [k, v] of Object.entries(built.bindings)) layerReq.input(k, v);
        const layerCells = (await layerReq.query(buildContextRollupSql({
          values: cutValues, identityJoin: idJoin, subjectId: cutSubjectId, subjectScope: cutSubjectId,
          subjectSql: built.subjectSql, resourceSql: built.resourceSql,
        }))).recordset;

        const layerResMap = new Map();
        for (const row of layerCells) {
          if (!row.resourceId || layerResMap.has(row.resourceId)) continue;
          layerResMap.set(row.resourceId, resourceMeta(row));
        }

        // SCOPED member counts for the header (direct / total), so they match the
        // assignment-scoped cells and member drill rather than raw org size.
        const scReq = timedRequest(p, `matrix-ctx-scoped-members[${rowType}]`, res);
        for (const [k, v] of Object.entries(built.bindings)) scReq.input(k, v);
        const scMap = new Map((await scReq.query(buildContextScopedMemberCountsSql({
          values: cutValues, identityJoin: idJoin, subjectId: cutSubjectId, subjectScope: cutSubjectId,
          subjectSql: built.subjectSql, resourceSql: built.resourceSql,
        }))).recordset.map(r => [r.groupValue, { total: r.total, direct: r.direct }]));

        // Fold inherited (effective) access into the org-rollup cells.
        let inhCtx = null;
        if (includeInherited) {
          try { inhCtx = await buildInheritedContextCounts(p, built, rowType, cutNodes.map(n => n.id)); }
          catch (err) { built.warnings.push('inherited context fold failed: ' + err.message); }
        }
        const inhTotByNode = new Map((inhCtx?.groupTotals || []).map(t => [t.groupValue, t.total]));
        for (const r of (inhCtx?.resources || [])) if (!layerResMap.has(r.resourceId)) layerResMap.set(r.resourceId, r);

        // Hide org branches with no in-scope assignments: a column only shows if
        // some resource has a Direct (or inherited) count for that node's subtree.
        const cellNodeIds = new Set([...layerCells.map(c => c.groupValue), ...(inhCtx?.groupValues || [])]);
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
            ...(inhCtx?.counts || []),
          ],
          ...layerCounts, totalUsers: layerCounts.subjectTotal, warnings: built.warnings,
        });
      }

      // The view zooms one level at a time. focus = the node we're zoomed into
      // (the last step of the drill path, or the root). Columns = the focus
      // node's children; the breadcrumb is root → … → focus.
      const path = filter.rollupPath.filter(isUuid);
      const focus = path.length ? path[path.length - 1] : filter.rollupContextId;

      const kidsReq = timedRequest(p, 'matrix-ctx-focus-children', res);
      let frontier = (await kidsReq.query(buildRootChildrenSql(focus))).recordset.map(r => r.id);
      if (frontier.length === 0) frontier = [focus]; // leaf focus — show it as the single column

      let values;
      try { values = frontierValues(frontier); }
      catch { return res.status(400).json({ error: 'Invalid frontier' }); }

      const { join: identityJoin, subjectId: ctxSubjectId } = buildIdentityJoinExprs(rowType);

      // Roles-only leaf drill: expand one org (already scoped via a subject
      // context condition) into its subjects + the business role each holds.
      if (filter.drill) {
        const { join: brSubjectJoin, id: brId, name: brName, type: brType } = buildRoleSubjectJoinExprs(rowType);
        const drillReq = timedRequest(p, `matrix-ctx-rows-drill[${rowType}]`, res);
        for (const [k, v] of Object.entries(built.bindings)) drillReq.input(k, v);
        const members = (await drillReq.query(buildRolesDrillSql({
          subjectJoin: brSubjectJoin, subjectIdExpr: brId,
          subjectNameExpr: brName,
          subjectTypeExpr: brType,
          subjectIdForFilter: brId, subjectSql: built.subjectSql,
        }))).recordset;
        return res.json({ rollup: 'context', rollupKind: 'context', rollupContent: 'roles-only', drill: { members } });
      }

      // Shared: per-node subject totals (% denominator), node metadata, breadcrumb.
      const totalsReq = timedRequest(p, `matrix-ctx-totals[${rowType}]`, res);
      for (const [k, v] of Object.entries(built.bindings)) totalsReq.input(k, v);
      const ctxTotals = (await totalsReq.query(buildContextTotalsSql({
        values, identityJoin, subjectId: ctxSubjectId, subjectScope: ctxSubjectId,
        subjectSql: built.subjectSql,
      }))).recordset.map(r => ({ groupValue: r.groupValue, total: r.total }));

      const nodesReq = timedRequest(p, 'matrix-ctx-nodes', res);
      const nodeRows = (await nodesReq.query(buildContextNodesSql(frontier))).recordset;
      const nodeMeta = new Map(nodeRows.map(n => [n.id, { id: n.id, displayName: n.displayName, parent: n.parent, total: n.total, directMembers: n.directMembers, childCount: n.childCount }]));
      const orderedFrontier = [...frontier].sort((a, b) => (nodeMeta.get(b)?.total || 0) - (nodeMeta.get(a)?.total || 0));

      const crumbIds = [filter.rollupContextId, ...path];
      const crumbReq = timedRequest(p, 'matrix-ctx-crumbs', res);
      const crumbRows = (await crumbReq.query(buildContextNodesSql(crumbIds))).recordset;
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

      // ── Business roles on the rows (org units stay on the columns) ──
      if (filter.rollupContent === 'roles-only') {
        const rrReq = timedRequest(p, `matrix-ctx-roles-rows[${rowType}]`, res);
        for (const [k, v] of Object.entries(built.bindings)) rrReq.input(k, v);
        const roleRowsRes = (await rrReq.query(buildContextRolesAsRowsSql({
          values, identityJoin, subjectId: ctxSubjectId, subjectScope: ctxSubjectId,
          subjectSql: built.subjectSql,
        }))).recordset;
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

      // ── Resources on the rows (+ optional business-role count columns) ──
      const cellsReq = timedRequest(p, `matrix-ctx-rollup[${rowType}]`, res);
      for (const [k, v] of Object.entries(built.bindings)) cellsReq.input(k, v);
      const cellRows = (await cellsReq.query(buildContextRollupSql({
        values, identityJoin, subjectId: ctxSubjectId, subjectScope: ctxSubjectId,
        subjectSql: built.subjectSql, resourceSql: built.resourceSql,
      }))).recordset;

      const resMap = new Map();
      for (const row of cellRows) {
        if (!row.resourceId || resMap.has(row.resourceId)) continue;
        resMap.set(row.resourceId, {
          resourceId: row.resourceId, resourceDisplayName: row.resourceDisplayName,
          resourceType: row.resourceType, resourceDescription: row.resourceDescription,
          systemId: row.systemId, systemName: row.systemName,
        });
      }

      // Fold inherited (effective) access into the org-rollup cells (zoom view).
      // The frontier columns already exist, so we only add resources + counts.
      let inhCtx2 = null;
      if (includeInherited) {
        try { inhCtx2 = await buildInheritedContextCounts(p, built, rowType, frontier); }
        catch (err) { built.warnings.push('inherited context fold failed: ' + err.message); }
      }
      for (const r of (inhCtx2?.resources || [])) if (!resMap.has(r.resourceId)) resMap.set(r.resourceId, r);

      let businessRoles = [];
      const roleCounts = [];
      if (filter.rollupContent !== 'resources-only') {
        try {
          const brReq = timedRequest(p, `matrix-ctx-roles[${rowType}]`, res);
          for (const [k, v] of Object.entries(built.bindings)) brReq.input(k, v);
          const brRows = (await brReq.query(buildContextRolesSql({
            values, identityJoin, subjectId: ctxSubjectId, subjectScope: ctxSubjectId,
            subjectSql: built.subjectSql, resourceSql: built.resourceSql,
          }))).recordset;
          const roleMap = new Map();
          for (const r of brRows) {
            if (!r.roleId) continue;
            if (!roleMap.has(r.roleId)) roleMap.set(r.roleId, { id: r.roleId, displayName: r.roleName || r.roleId });
            roleCounts.push({ resourceId: r.resourceId, roleId: r.roleId, count: r.count });
          }
          businessRoles = [...roleMap.values()].sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
        } catch { /* business-role view may be absent */ }
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
    if (filter.rollup) {
      const subjCols = rowType === 'identity' ? built.identityCols : built.principalCols;
      const resolved = resolveAttrExpr(filter.rollup, subjectAlias, subjCols);
      if (resolved.error) return res.status(400).json({ error: resolved.error });

      // Per-group subject denominator for the "% of subjects" metric. Returned
      // in every roll-up response so the frontend can switch count↔percent
      // without a re-query.
      const totalsReq = timedRequest(p, `matrix-rollup-totals[${rowType}]`, res);
      for (const [k, v] of Object.entries(built.bindings)) totalsReq.input(k, v);
      const groupTotals = (await totalsReq.query(buildGroupTotalsSql({
        attrExpr: resolved.attrExpr,
        subjectTable: rowType === 'identity' ? 'Identities' : 'Principals',
        subjectAlias,
        subjectSql: built.subjectSql,
      }))).recordset.map(r => ({ groupValue: r.groupValue, total: r.total }));

      // ─── Business roles as rows ───
      if (filter.rollupContent === 'roles-only') {
        const { join: brSubjectJoin, id: brSubjectId, name: brSubjectName, type: brSubjectType } = buildRoleSubjectJoinExprs(rowType);

        // Drill-down: expand one group column into its individual subjects +
        // which business role each holds. The group is already scoped via a
        // subject attribute condition the frontend added, so subjectSql carries
        // the constraint. Returns a compact { members } payload only.
        if (filter.drill) {
          const drillReq = timedRequest(p, `matrix-rollup-rows-drill[${rowType}]`, res);
          for (const [k, v] of Object.entries(built.bindings)) drillReq.input(k, v);
          const members = (await drillReq.query(buildRolesDrillSql({
            subjectJoin: brSubjectJoin,
            subjectIdExpr: brSubjectId,
            subjectNameExpr: brSubjectName,
            subjectTypeExpr: brSubjectType,
            subjectIdForFilter: brSubjectId,
            subjectSql: built.subjectSql,
          }))).recordset;
          return res.json({ rollup: filter.rollup, rollupContent: 'roles-only', drill: { members } });
        }

        const rolesReq = timedRequest(p, `matrix-rollup-rows[${rowType}]`, res);
        for (const [k, v] of Object.entries(built.bindings)) rolesReq.input(k, v);
        const rolesResult = (await rolesReq.query(buildRolesAsRowsSql({
          attrExpr: resolved.attrExpr,
          subjectJoin: brSubjectJoin,
          subjectIdExpr: brSubjectId,
          subjectIdForFilter: brSubjectId,
          subjectSql: built.subjectSql,
        }))).recordset;

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

      const rollupReq = timedRequest(p, `matrix-rollup[${rowType}]`, res);
      for (const [k, v] of Object.entries(built.bindings)) rollupReq.input(k, v);
      const rollupResult = await rollupReq.query(buildRollupSql({
        attrExpr: resolved.attrExpr,
        subjectJoin,
        subjectIdExpr: memberIdExpr,
        subjectIdForFilter,
        subjectSql: built.subjectSql,
        resourceSql: built.resourceSql,
      }));

      const counts = await scopeCounts(p, res, rowType, built);
      const resMap = new Map();
      const groupSet = new Set();
      for (const row of rollupResult.recordset) {
        if (!resMap.has(row.resourceId)) {
          resMap.set(row.resourceId, {
            resourceId: row.resourceId,
            resourceDisplayName: row.resourceDisplayName,
            resourceType: row.resourceType,
            resourceDescription: row.resourceDescription,
            systemId: row.systemId,
            systemName: row.systemName,
          });
        }
        groupSet.add(row.groupValue);
      }

      // Fold inherited (effective) access into the count cells (Phase 2). The
      // declared rollup above is empty for scope-node scopes; the engine yields
      // the effective counts per (synthesized capability, group-value).
      let inhCounts = [];
      let inhGroupTotals = [];
      if (includeInherited) {
        try {
          const inh = await buildInheritedRollupCounts(p, built, rowType, filter.rollup, built.principalCols);
          if (inh) {
            for (const r of inh.resources) if (!resMap.has(r.resourceId)) resMap.set(r.resourceId, r);
            for (const gv of inh.groupValues) groupSet.add(gv);
            inhCounts = inh.counts;
            inhGroupTotals = inh.groupTotals;
          }
        } catch (err) { built.warnings.push('inherited rollup fold failed: ' + err.message); }
      }

      // Business-role (SOLL) counts: how many in-scope subjects hold each
      // resource via each business role. Mirrors the SOLL columns of the
      // per-subject matrix, but aggregated to a count.
      let businessRoles = [];
      const roleCounts = [];
      if (filter.rollupContent !== 'resources-only') {
        try {
          const { memberId: brMemberId, join: brJoin } = buildApMemberExprs(rowType);
          const brReq = timedRequest(p, 'matrix-rollup-roles', res);
          for (const [k, v] of Object.entries(built.bindings)) brReq.input(k, v);
          const brRows = (await brReq.query(buildRollupRolesSql({
            brMemberId, brJoin, subjectSql: built.subjectSql, resourceSql: built.resourceSql,
          }))).recordset;
          const roleMap = new Map();
          for (const r of brRows) {
            if (!r.roleId) continue;
            if (!roleMap.has(r.roleId)) roleMap.set(r.roleId, { id: r.roleId, displayName: r.roleName || r.roleId });
            roleCounts.push({ resourceId: r.resourceId, roleId: r.roleId, count: r.count });
          }
          businessRoles = [...roleMap.values()].sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
        } catch { /* business-role view may be absent */ }
      }

      const mergedGroupTotals = mergeGroupTotals(groupTotals, inhGroupTotals);

      return res.json({
        rollup: filter.rollup,
        rollupContent: filter.rollupContent,
        rowType,
        resources: [...resMap.values()],
        groupValues: [...groupSet].sort((a, b) => String(a).localeCompare(String(b))),
        groupTotals: mergedGroupTotals,
        counts: [
          ...rollupResult.recordset.map(r => ({
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

    const where = [`(p."principalType" IS NULL OR p."principalType" != '#microsoft.graph.group')`];
    if (built.subjectSql)  where.push(`${subjectIdForFilter} IN ${built.subjectSql}`);
    if (built.resourceSql) where.push(`p."resourceId" IN ${built.resourceSql}`);

    // DISTINCT collapses the cross product when one identity has many
    // principals → many duplicate matrix rows. No-op for rowType=principal.
    const distinct = rowType === 'identity' ? 'DISTINCT' : '';

    const dataReq = timedRequest(p, `matrix-data[${rowType}]`, res);
    for (const [k, v] of Object.entries(built.bindings)) dataReq.input(k, v);

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
    const result = await dataReq.query(dataSql);

    // ── Inherited (effective) access fold ──────────────────────────────────
    // Additive: the declared query above is empty for scope-node scopes (key
    // vaults, a region) because Azure access lives on capability-resources, not
    // the nodes. The engine returns the effective capabilities AT those nodes.
    if (includeInherited) {
      try {
        const effFlat = await buildInheritedFlatRows(p, built, rowType, subjectCols);
        const seen = new Set(result.recordset.map((r) => `${r.resourceId}|${r.memberId}`));
        for (const er of effFlat) {
          const k = `${er.resourceId}|${er.memberId}`;
          if (!seen.has(k)) { seen.add(k); result.recordset.push(er); } // declared wins
        }
      } catch (err) {
        built.warnings.push('inherited-access fold failed: ' + err.message);
      }
    }

    // Backstop: a flat per-subject grid serializes every assignment row into one
    // JSON string. Past ~half a million rows that string can exceed V8's max
    // length (RangeError: Invalid string length) and crash the response. Fail
    // cleanly with guidance toward the aggregated views instead.
    const MAX_FLAT_ROWS = 400_000;
    if (result.recordset.length > MAX_FLAT_ROWS) {
      return res.status(413).json({
        error: `This matrix has ${result.recordset.length.toLocaleString()} assignments — too many to load as a per-subject grid. Sort by Manager Hierarchy or roll up by an attribute (both aggregate on the server), or add filters to narrow it.`,
      });
    }

    const { subjectCount, subjectTotal, resourceCount, resourceTotal } = await scopeCounts(p, res, rowType, built);

    // AP mapping — keyed by memberId (principal or identity depending on
    // rowType) so the existing frontend renders SOLL columns correctly.
    let managedByPackages = [];
    try {
      const apReq = timedRequest(p, 'matrix-data-ap-mapping', res);
      for (const [k, v] of Object.entries(built.bindings)) apReq.input(k, v);

      const apMemberIdExpr = rowType === 'identity'
        ? 'im2."identityId"'
        : 'ap."userId"';
      const apJoin = rowType === 'identity'
        ? `INNER JOIN "IdentityMembers" im2 ON im2."principalId" = ap."userId"`
        : '';
      const apWhere = [];
      if (built.subjectSql)  apWhere.push(`${apMemberIdExpr} IN ${built.subjectSql}`);
      if (built.resourceSql) apWhere.push(`ap."resourceId" IN ${built.resourceSql}`);

      const apResult = await apReq.query(`
        SELECT ${apMemberIdExpr} AS "memberId",
               ap."resourceId" AS "resourceId",
               ap."resourceId" AS "groupId",
               string_agg(DISTINCT ap."businessRoleId"::text, ',') AS "accessPackageIds"
          FROM "vw_UserPermissionAssignmentViaBusinessRole" ap
          ${apJoin}
          ${apWhere.length ? 'WHERE ' + apWhere.join(' AND ') : ''}
          GROUP BY ${apMemberIdExpr}, ap."resourceId"
      `);
      managedByPackages = apResult.recordset
        .filter(r => r.memberId)
        .map(r => ({
          memberId: r.memberId,
          resourceId: r.resourceId || r.groupId,
          groupId: r.groupId || r.resourceId,
          accessPackageIds: r.accessPackageIds ? r.accessPackageIds.split(',') : [],
        }));
    } catch { /* AP view may not exist */ }

    return res.json({
      data: result.recordset,
      rowType,
      subjectCount,
      subjectTotal,
      resourceCount,
      resourceTotal,
      // Backward-compat alias used by the existing matrix toolbar footer.
      totalUsers: subjectTotal,
      managedByPackages,
      warnings: built.warnings,
    });
  } catch (err) {
    console.error('matrix/data failed:', err.message, '\nStack:', err.stack);
    return res.status(500).json({ error: 'Matrix query failed' });
  }
});

export default router;
