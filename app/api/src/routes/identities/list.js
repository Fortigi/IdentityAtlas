// Identity list + column-discovery endpoints — /api/identities and
// /api/identity-columns (the list's filter-bar columns).
//
// Extracted verbatim from routes/identities.js (audit finding C1). Mounted by
// routes/identities.js via router.use(), so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import { timedQuery } from '../../perf/sqlTimer.js';
import { bindNamedParams } from '../../db/namedParams.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { useSql, db, hasTable } from './shared.js';

const router = Router();

function parseTagString(tagString) {
  if (!tagString) return [];
  return tagString.split('|').map(t => {
    const parts = t.split(':');
    return { id: parseInt(parts[0]), name: parts[1], color: parts[2] };
  });
}

// GET /api/identities — summary + paginated list
router.get('/identities', async (req, res) => {
  if (!useSql) return res.json({ available: false, data: [], total: 0, summary: null });

  try {
    const p = await db.getPool();

    if (!(await hasTable(p, 'Identities'))) {
      return res.json({ available: false, data: [], total: 0, summary: null });
    }

    const { search, minAccounts, confidence, hrAnchored, orphanStatus, sort, limit, offset } = req.query;
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
    // the summary query below. It's a tiny catalog lookup — keeping it out
    // of the parallel batch is cheap.
    const colCheck = await db.query(`
      SELECT column_name AS "COLUMN_NAME" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Identities' AND column_name IN ('isHrAnchored', 'orphanStatus')
    `);
    const hasHrCols = colCheck.rows.length >= 2;

    // The three big queries are independent — run them in parallel so
    // postgres can schedule them on separate backends.
    const [summaryResult, typeDistResult] = await Promise.all([
      timedQuery(p, 'identity-summary', res, `
        SELECT
          COUNT(*) AS "totalIdentities",
          SUM(CASE WHEN "accountCount" > 1 THEN 1 ELSE 0 END) AS "multiAccountIdentities",
          SUM(CASE WHEN "accountCount" = 1 THEN 1 ELSE 0 END) AS "singleAccountIdentities",
          SUM("accountCount") AS "totalAccounts",
          AVG(CAST("linkConfidence" AS FLOAT)) AS "avgConfidence",
          MAX("linkedAt") AS "lastLinkedAt"
          ${hasHrCols ? `, SUM(CASE WHEN "isHrAnchored" = true THEN 1 ELSE 0 END) AS "hrAnchoredCount",
          SUM(CASE WHEN "orphanStatus" IS NOT NULL THEN 1 ELSE 0 END) AS "orphanCount"` : ''}
        FROM "Identities"
      `),
      timedQuery(p, 'identity-type-dist', res, `
        SELECT "accountType", COUNT(*) AS cnt
        FROM "IdentityMembers"
        GROUP BY "accountType"
        ORDER BY cnt DESC
      `),
    ]);
    const summary = summaryResult.rows[0];
    summary.accountTypeDistribution = typeDistResult.rows;

    // Build filtered query
    let where = 'WHERE 1=1';
    const inputs = {};

    if (search) {
      where += ` AND ("displayName" ILIKE @search OR email ILIKE @search OR "jobTitle" ILIKE @search OR "employeeId" ILIKE @search)`;
      inputs.search = `%${search}%`;
    }

    if (minAccounts) {
      const min = parseInt(minAccounts);
      if (min > 1) {
        where += ' AND "accountCount" >= @minAccounts';
        inputs.minAccounts = min;
      }
    }

    if (confidence) {
      where += ' AND "linkConfidence" >= @confidence';
      inputs.confidence = parseInt(confidence);
    }

    if (hasHrCols) {
      if (hrAnchored === 'true') {
        where += ' AND "isHrAnchored" = true';
      } else if (hrAnchored === 'false') {
        where += ' AND ("isHrAnchored" = false OR "isHrAnchored" IS NULL)';
      }

      if (orphanStatus === 'any') {
        where += ' AND "orphanStatus" IS NOT NULL';
      } else if (orphanStatus === 'none') {
        where += ' AND "orphanStatus" IS NULL';
      } else if (orphanStatus) {
        where += ' AND "orphanStatus" = @orphanStatus';
        inputs.orphanStatus = orphanStatus;
      }
    }

    // Apply the attribute filters that useEntityPage sends (simple
    // field=value equality on whitelisted columns).
    const IDENTITY_FILTER_COLS = new Set([
      'displayName', 'email', 'department', 'jobTitle', 'companyName',
      'city', 'country', 'employeeId', 'accountCount',
    ]);
    for (const [field, value] of Object.entries(attrFilters)) {
      if (!IDENTITY_FILTER_COLS.has(field)) continue;
      if (value == null || value === '') continue;
      const key = `flt_${field}`;
      where += ` AND "${field}" = @${key}`;
      inputs[key] = value;
    }

    // Tag filter (virtual field).
    let identityTagJoin = '';
    if (identityTagFilter) {
      identityTagJoin = `
        INNER JOIN "GraphTagAssignments" _ita ON _ita."entityId" = UPPER(i.id::text)
        INNER JOIN "GraphTags" _it ON _ita."tagId" = _it.id
          AND _it."name" = @__identityTag AND _it."entityType" = 'identity'`;
      inputs.__identityTag = identityTagFilter;
    }

    // Sort
    const ALLOWED_SORTS = {
      'accountCount': '"accountCount" DESC',
      'confidence': '"linkConfidence" DESC',
      'displayName': '"displayName" ASC',
      'department': 'department ASC',
      'linkedAt': '"linkedAt" DESC',
    };
    const orderBy = ALLOWED_SORTS[sort] || '"displayName" ASC';

    // Page first, then resolve tags only for the page rows; count only on page 1.
    // (Same export-pagination fix as /api/users — the per-row tag subquery used to
    // run for every offset+limit row before OFFSET discarded the first `offset`,
    // quadratic across an export and slow enough to time out a deep page.)
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
        LIMIT @pageLimit OFFSET @pageOffset
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

    // The data query binds the filter inputs plus the page window; the COUNT
    // query binds only the inputs it references (bindNamedParams drops the
    // @pageLimit/@pageOffset it never mentions), so the same map serves both.
    const bindings = { ...inputs, pageOffset, pageLimit };
    const dataQ = bindNamedParams(dataSql, bindings);

    // Fire count (page 1 only) before data so the call order matches the
    // legacy Promise.all([count, data]) — keeps the mocked unit tests valid.
    let total = null;
    let dataResult;
    if (pageOffset === 0) {
      const countQ = bindNamedParams(
        `SELECT COUNT(*)::int AS total FROM "Identities" i ${identityTagJoin} ${where}`,
        bindings,
      );
      const [countResult, dr] = await Promise.all([
        timedQuery(p, 'identity-count', res, countQ.text, countQ.values),
        timedQuery(p, 'identity-list', res, dataQ.text, dataQ.values),
      ]);
      total = countResult.rows[0].total;
      dataResult = dr;
    } else {
      dataResult = await timedQuery(p, 'identity-list', res, dataQ.text, dataQ.values);
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

    const grouped = {};
    if (schemaOnly) {
      for (const col of FILTER_COLS) grouped[col] = [];
    } else {
      // One pass per column — each read is cheap (a few hundred distinct
      // values at most on a real tenant) and keeps the SQL trivial.
      for (const col of FILTER_COLS) {
        try {
          const r = await db.query(
            `SELECT DISTINCT "${col}" AS v FROM "Identities" WHERE "${col}" IS NOT NULL AND "${col}" <> '' ORDER BY "${col}" LIMIT 500`
          );
          grouped[col] = r.rows.map(x => x.v);
        } catch (e) { if (!isMissingSchema(e)) throw e; grouped[col] = []; }
      }
    }

    // Virtual tag-name column.
    try {
      const r = await db.query(`
        SELECT t.name
          FROM "GraphTags" t
         WHERE t."entityType" = 'identity'
           AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
         ORDER BY t.name
      `);
      grouped['__identityTag'] = schemaOnly ? [] : r.rows.map(x => x.name);
    } catch (e) { if (!isMissingSchema(e)) throw e; /* GraphTags may not exist yet */ }

    return res.json(Object.entries(grouped).map(([column, values]) => ({ column, values })));
  } catch (err) {
    console.error('identity-columns failed:', err.message);
    return res.json([]);
  }
});

export default router;
