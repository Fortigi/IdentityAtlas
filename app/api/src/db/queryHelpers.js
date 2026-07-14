import { timedQuery } from '../perf/sqlTimer.js';

/**
 * Runs a paginated data + count query against RiskScores with a caller-supplied
 * JOIN and WHERE clause. Returns { data: rows[], total: number }.
 *
 * The caller builds whereClause and params (via createParams) so that
 * entity-specific filter conditions (search columns, extra filters like
 * department/resourceType) stay in the route handler. `params` holds the filter
 * values already bound as $1..$N in whereClause; the data query appends
 * LIMIT/OFFSET as the next two placeholders, while the COUNT query — which
 * doesn't page — takes just the filter params.
 */
export async function queryRiskScoresPage(pool, res, {
  label,        // timer label prefix, e.g. 'risk-users'
  fromClause,   // SQL after "FROM \"RiskScores\" rs", e.g. 'INNER JOIN "Principals" p ON ...'
  selectCols,   // additional SELECT columns beyond rs.*, e.g. 'p."displayName", p.email AS ...'
  whereClause,  // full WHERE clause including entity-type predicate; references $1..$N from params
  params,       // positional filter values bound in whereClause
  limit,
  offset,
}) {
  const limitPh  = `$${params.length + 1}`;
  const offsetPh = `$${params.length + 2}`;

  const dataResult = await timedQuery(pool, `${label}-list`, res, `
    SELECT rs.*, ${selectCols}
    FROM "RiskScores" rs
    ${fromClause}
    ${whereClause}
    ORDER BY rs."riskScore" DESC
    LIMIT ${limitPh} OFFSET ${offsetPh}
  `, [...params, limit, offset]);

  const countResult = await timedQuery(pool, `${label}-count`, res, `
    SELECT COUNT(*) AS total
    FROM "RiskScores" rs
    ${fromClause}
    ${whereClause}
  `, params);

  return {
    data:  dataResult.rows,
    total: countResult.rows[0].total,
  };
}
