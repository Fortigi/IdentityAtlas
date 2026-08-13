// Identity list + column-discovery endpoints — /api/identities and
// /api/identity-columns (the list's filter-bar columns).
//
// Extracted verbatim from routes/identities.js (audit finding C1). Mounted by
// routes/identities.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { timedQuery } from '../../perf/sqlTimer.js';
import { createParams } from '../../db/sqlParams.js';
import { buildOrderBy } from '../../lib/listSort.js';
import { useSql, db, hasTable } from './shared.js';
import { parseTagString, buildIdentityListWhere, fetchIdentitySummary, fetchIdentityColumns } from './listQuery.js';

const router = Router();

// Columns the Identities page lets you sort by (its TABLE_COLUMNS keys), plus
// two legacy keys (confidence/linkedAt) other callers pass. Values are the page
// CTE's output aliases — safe to interpolate; see lib/listSort.js.
const IDENTITY_SORTS = {
  displayName: '"displayName"',
  primaryAccountUpn: '"primaryAccountUpn"',
  accountCount: '"accountCount"',
  department: '"department"',
  jobTitle: '"jobTitle"',
  confidence: '"linkConfidence"',
  linkedAt: '"linkedAt"',
};

// GET /api/identities — summary + paginated list
router.get('/identities', async (req, res) => {
  if (!useSql) return res.json({ available: false, data: [], total: 0, summary: null });

  try {
    const p = await db.getPool();

    if (!(await hasTable(p, 'Identities'))) {
      return res.json({ available: false, data: [], total: 0, summary: null });
    }

    const { search, minAccounts, confidence, hrAnchored, orphanStatus, sort, dir, limit, offset } = req.query;
    const pageLimit = Math.min(parseInt(limit) || 50, 500);
    const pageOffset = parseInt(offset) || 0;

    // Attribute filters (JSON blob from the useEntityPage filter bar). Accept
    // a `__identityTag` virtual field for tag-name filtering.
    let attrFilters = {};
    if (req.query.filters) {
      try { attrFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
    }
    let identityTagFilter = null;
    if (attrFilters['__identityTag']) {
      identityTagFilter = String(attrFilters['__identityTag']);
      delete attrFilters['__identityTag'];
    }

    // Column-existence check runs first because it determines the shape of
    // the summary query below. It's a tiny catalog lookup.
    const colCheck = await db.query(`
      SELECT column_name AS "COLUMN_NAME" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Identities' AND column_name IN ('isHrAnchored', 'orphanStatus')
    `);
    const hasHrCols = colCheck.rows.length >= 2;

    const summary = await fetchIdentitySummary(p, res, hasHrCols);

    // Build the filtered query.
    const { params, bind } = createParams();
    const { where, identityTagJoin } = buildIdentityListWhere(
      { search, minAccounts, confidence, hrAnchored, orphanStatus, attrFilters, identityTagFilter, hasHrCols },
      bind,
    );

    // Sort the whole result set server-side (audit H-14), column + direction
    // from the query; unknown columns fall back to displayName ASC.
    const orderBy = buildOrderBy(sort, dir, IDENTITY_SORTS);

    // Page first, then resolve tags only for the page rows; count only on page 1.
    // (Same export-pagination fix as /api/users — the per-row tag subquery used to
    // run for every offset+limit row before OFFSET discarded the first `offset`,
    // quadratic across an export and slow enough to time out a deep page.)
    const countParams = [...params]; // filter params only — snapshot before LIMIT/OFFSET
    const dataSql = `
      WITH page AS (
        SELECT i.id, i."displayName", i."primaryPrincipalId" AS "primaryAccountId", i.email AS "primaryAccountUpn",
          i."accountCount", NULL AS "accountTypes",
          i."linkConfidence", NULL AS "linkSignals", i.department, i."jobTitle",
          NULL AS "managerId", i.email AS mail,
          i."givenName", i.surname, i."employeeId", i."companyName", NULL AS "employeeType",
          i.city, i.country, i."officeLocation",
          NULL AS "accountEnabled", i."linkedAt"
          ${hasHrCols ? ', i."isHrAnchored", NULL AS "hrAccountId", i."orphanStatus"' : ''}
        FROM "Identities" i
        ${identityTagJoin}
        ${where}
        ORDER BY ${orderBy}
        LIMIT ${bind(pageLimit)} OFFSET ${bind(pageOffset)}
      )
      SELECT page.*,
        (SELECT string_agg(t.id::text || ':' || t."name" || ':' || t."color", '|')
           FROM "GraphTagAssignments" ta
           INNER JOIN "GraphTags" t ON ta."tagId" = t.id AND t."entityType" = 'identity'
          WHERE ta."entityId" = UPPER(page.id::text)
        ) AS "tagString"
      FROM page
      ORDER BY ${orderBy}
    `;

    // The COUNT query (page 1 only) binds just the filter params; the data query
    // reuses those plus the page window. Snapshot before binding LIMIT/OFFSET so
    // the count SQL isn't handed parameters it never references.
    let total = null;
    let dataResult;
    if (pageOffset === 0) {
      // Fire count before data so the call order matches the legacy
      // Promise.all([count, data]) — keeps the mocked unit tests valid.
      const [countResult, dr] = await Promise.all([
        timedQuery(p, 'identity-count', res, `SELECT COUNT(*)::int AS total FROM "Identities" i ${identityTagJoin} ${where}`, countParams),
        timedQuery(p, 'identity-list', res, dataSql, params),
      ]);
      total = countResult.rows[0].total;
      dataResult = dr;
    } else {
      dataResult = await timedQuery(p, 'identity-list', res, dataSql, params);
    }
    const data = dataResult.rows.map(row => {
      const { tagString, ...rest } = row;
      return { ...rest, tags: parseTagString(tagString) };
    });

    res.json({
      available: true,
      summary,
      data,
      total,
      hasHrColumns: hasHrCols,
    });
  } catch (err) {
    console.error('Error fetching identities:', err.message);
    res.status(500).json({ error: 'Failed to fetch identities' });
  }
});

// GET /api/identities/:id — single identity with all linked accounts
// ─── GET /api/identity-columns ──────────────────────────────────────────
// Column discovery for the Identities page filter bar. Returns distinct
// values for a small whitelist of filterable columns, plus the virtual
// __identityTag column populated with existing tag names. Mirrors the
// /api/resource-columns shape the useEntityPage hook expects.
router.get('/identity-columns', async (req, res) => {
  if (!useSql) return res.json([]);
  const schemaOnly = req.query.schema === 'true';
  const FILTER_COLS = [
    'displayName', 'email', 'department', 'jobTitle',
    'companyName', 'city', 'country', 'employeeId',
  ];
  try {
    const p = await db.getPool();
    if (!(await hasTable(p, 'Identities'))) return res.json([]);

    return res.json(await fetchIdentityColumns(p, schemaOnly, FILTER_COLS));
  } catch (err) {
    console.error('identity-columns failed:', err.message);
    return res.json([]);
  }
});

export default router;
