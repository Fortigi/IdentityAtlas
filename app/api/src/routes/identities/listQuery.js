// Query helpers for GET /api/identities and /api/identity-columns, extracted
// from identities/list.js so the handlers stay under the complexity
// threshold. parseTagString + buildIdentityListWhere are pure and
// unit-tested directly; the summary/columns fetchers are covered end-to-end by
// identities.coverage.test.js + identities.contract.test.js. SQL moved verbatim.

import { timedQuery } from '../../perf/sqlTimer.js';
import { isMissingSchema } from '../../db/schemaErrors.js';
import { db } from './shared.js';

// Whitelisted columns the useEntityPage filter bar can filter on (equality).
const IDENTITY_FILTER_COLS = new Set([
  'displayName', 'email', 'department', 'jobTitle', 'companyName',
  'city', 'country', 'employeeId', 'accountCount',
]);

// Parse the per-row tag aggregate ("id:name:color|...") into objects. Pure.
export function parseTagString(tagString) {
  if (!tagString) return [];
  return tagString.split('|').map(t => {
    const parts = t.split(':');
    return { id: parseInt(parts[0]), name: parts[1], color: parts[2] };
  });
}

// HR-anchored / orphan-status clauses (only when the HR columns exist).
function hrFilterClauses(hrAnchored, orphanStatus, bind) {
  let where = '';
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
    where += ` AND "orphanStatus" = ${bind(orphanStatus)}`;
  }
  return where;
}

// Equality clauses for the useEntityPage attribute filters (whitelisted columns).
function attrFilterClauses(attrFilters, bind) {
  let where = '';
  for (const [field, value] of Object.entries(attrFilters)) {
    if (!IDENTITY_FILTER_COLS.has(field)) continue;
    if (value == null || value === '') continue;
    where += ` AND "${field}" = ${bind(value)}`;
  }
  return where;
}

// Build the WHERE clause + optional tag JOIN for the identity list, binding
// values through the caller's `bind`. Returns { where, identityTagJoin }.
export function buildIdentityListWhere(f, bind) {
  const { search, minAccounts, confidence, hrAnchored, orphanStatus, attrFilters, identityTagFilter, hasHrCols } = f;

  let where = 'WHERE 1=1';
  if (search) {
    const s = bind(`%${search}%`);
    where += ` AND ("displayName" ILIKE ${s} OR email ILIKE ${s} OR "jobTitle" ILIKE ${s} OR "employeeId" ILIKE ${s})`;
  }
  if (minAccounts) {
    const min = parseInt(minAccounts);
    if (min > 1) where += ` AND "accountCount" >= ${bind(min)}`;
  }
  if (confidence) {
    where += ` AND "linkConfidence" >= ${bind(parseInt(confidence))}`;
  }
  if (hasHrCols) where += hrFilterClauses(hrAnchored, orphanStatus, bind);
  where += attrFilterClauses(attrFilters, bind);

  let identityTagJoin = '';
  if (identityTagFilter) {
    identityTagJoin = `
        INNER JOIN "GraphTagAssignments" _ita ON _ita."entityId" = UPPER(i.id::text)
        INNER JOIN "GraphTags" _it ON _ita."tagId" = _it.id
          AND _it."name" = ${bind(identityTagFilter)} AND _it."entityType" = 'identity'`;
  }
  return { where, identityTagJoin };
}

// Summary card + account-type distribution — two independent aggregate queries
// run in parallel. hasHrCols toggles the HR-anchored / orphan roll-ups.
export async function fetchIdentitySummary(p, res, hasHrCols) {
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
  return summary;
}

// Distinct filter-column values (one cheap pass per column; a missing column is
// swallowed to an empty list).
async function fetchColumnValues(filterCols) {
  const grouped = {};
  for (const col of filterCols) {
    try {
      const r = await db.query(
        `SELECT DISTINCT "${col}" AS v FROM "Identities" WHERE "${col}" IS NOT NULL AND "${col}" <> '' ORDER BY "${col}" LIMIT 500`
      );
      grouped[col] = r.rows.map(x => x.v);
    } catch (e) { if (!isMissingSchema(e)) throw e; grouped[col] = []; }
  }
  return grouped;
}

// Existing identity tag names, or null when GraphTags is absent (so the caller
// can omit the virtual column entirely, matching the original).
async function fetchIdentityTagNames() {
  try {
    const r = await db.query(`
      SELECT t.name
        FROM "GraphTags" t
       WHERE t."entityType" = 'identity'
         AND EXISTS (SELECT 1 FROM "GraphTagAssignments" ta WHERE ta."tagId" = t.id)
       ORDER BY t.name
    `);
    return r.rows.map(x => x.name);
  } catch (e) { if (!isMissingSchema(e)) throw e; return null; /* GraphTags may not exist yet */ }
}

// /identity-columns: distinct filter-column values + the virtual __identityTag.
export async function fetchIdentityColumns(p, schemaOnly, filterCols) {
  const grouped = schemaOnly
    ? Object.fromEntries(filterCols.map(c => [c, []]))
    : await fetchColumnValues(filterCols);

  const tagNames = await fetchIdentityTagNames();
  if (tagNames !== null) grouped['__identityTag'] = schemaOnly ? [] : tagNames;

  return Object.entries(grouped).map(([column, values]) => ({ column, values }));
}
