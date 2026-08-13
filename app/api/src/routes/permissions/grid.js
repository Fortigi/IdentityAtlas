// Permission-grid endpoints — /api/permissions (the matrix data feed) and
// /api/user-columns (its filter columns).
//
// The heavy data-assembly logic lives in ./gridQuery.js (/permissions phases:
// parse, column discovery, context/tag/attribute filters, the top-N and
// unlimited query runners, the mock path) and ./userColumns.js (/user-columns).
// This file is the thin router that orchestrates those phases. Extracted from
// routes/permissions.js (audit finding C1) and further decomposed for
// complexity (#1028) — no behaviour change; the public paths are unchanged.

import { Router } from 'express';
import { useSql, db } from './shared.js';
import {
  parsePermissionsRequest,
  principalsTableExists,
  discoverGridColumns,
  resolveGridContextFilters,
  makeContextClauses,
  tryEffectiveAccessAtScopes,
  extractTagFilters,
  ensureTagTablesForFilters,
  splitValidFilters,
  makeFilterClauses,
  runLimitedGridQuery,
  runUnlimitedGridQuery,
  runMockPermissions,
  EMPTY_GRID,
} from './gridQuery.js';
import { buildMockUserColumns, fetchUserColumnValues } from './userColumns.js';

const router = Router();

// ─── GET /api/user-columns ────────────────────────────────────────
// Returns column names + distinct values from Principals for filter dropdowns.
// Values come from the FULL dataset (not limited by userLimit), so dropdowns
// show all possible options regardless of which page of users is loaded.
router.get('/user-columns', async (req, res) => {
  // ?schema=true — return column names only (no distinct values). Fast path
  // (~100ms) used by the frontend to recognise server-side filters without
  // waiting for the expensive UNION ALL distinct-values query.
  const schemaOnly = req.query.schema === 'true';
  try {
    if (!useSql) return res.json(buildMockUserColumns(schemaOnly));
    const p = await db.getPool();
    return res.json(await fetchUserColumnValues(p, schemaOnly, res));
  } catch (err) {
    console.error('user-columns query failed:', err.message);
    return res.json([]);
  }
});

// ─── GET /api/permissions ─────────────────────────────────────────
// Query params:
//   userLimit (int)  - limit to top N users by assignment count
//   filters  (JSON)  - server-side filters: {"department":"HR",...}
//                       Principal (user) columns and resource (group) columns both supported.
//   contextFilters   - Contexts-based principal/resource constraints (Phase 6)
router.get('/permissions', async (req, res) => {
  try {
    const { userLimit, requestedFilters } = parsePermissionsRequest(req);

    if (!useSql) {
      return res.json(runMockPermissions(requestedFilters, userLimit));
    }

    const p = await db.getPool();
    if (!(await principalsTableExists(p))) {
      return res.json(EMPTY_GRID);
    }

    const { colNames, groupColNames, dynamicUserCols } = await discoverGridColumns(p);
    const resolvedContextFilters = await resolveGridContextFilters(req);
    const contextClauses = makeContextClauses(resolvedContextFilters);

    // Resource-context scope path may short-circuit with effective-access rows.
    const effective = await tryEffectiveAccessAtScopes({ resolvedContextFilters, dynamicUserCols });
    if (effective) return res.json(effective);

    // Extract + provision tag filters, then validate/split the rest into user
    // vs group columns and build the attribute-filter clause factory.
    const tags = await ensureTagTablesForFilters(p, extractTagFilters(requestedFilters));
    const { validUserFilters, validGroupFilters } = splitValidFilters(requestedFilters, colNames, groupColNames);
    const filterClauses = makeFilterClauses({ validUserFilters, validGroupFilters, ...tags });

    const payload = userLimit > 0
      ? await runLimitedGridQuery({ p, res, userLimit, dynamicUserCols, filterClauses, contextClauses, userTagFilter: tags.userTagFilter })
      : await runUnlimitedGridQuery({ p, res, dynamicUserCols, filterClauses, contextClauses });

    return res.json(payload);
  } catch (err) {
    console.error('permissions query failed:', err.message, '\nStack:', err.stack);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
