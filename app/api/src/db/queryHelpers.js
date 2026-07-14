import { timedQuery } from '../perf/sqlTimer.js';
import { bindNamedParams } from './namedParams.js';

/**
 * Runs a paginated data + count query against RiskScores with a caller-supplied
 * JOIN and WHERE clause. Returns { data: rows[], total: number }.
 *
 * The caller builds whereClause and params so that entity-specific filter
 * conditions (search column names, extra filters like department/resourceType)
 * stay in the route handler. This helper only fires the two SQL statements.
 */
export async function queryRiskScoresPage(pool, res, {
  label,        // timer label prefix, e.g. 'risk-users'
  fromClause,   // SQL after "FROM \"RiskScores\" rs", e.g. 'INNER JOIN "Principals" p ON ...'
  selectCols,   // additional SELECT columns beyond rs.*, e.g. 'p."displayName", p.email AS ...'
  whereClause,  // full WHERE clause including entity-type predicate, e.g. 'WHERE rs."entityType" = \'Principal\' AND ...'
  params,       // [{ name, value }] — @name filters bound to both data and count queries
  limit,
  offset,
}) {
  // The caller's filter params plus the page window; the COUNT query binds only
  // the @names it references (bindNamedParams drops @limit/@offset).
  const bindings = { limit, offset };
  for (const { name, value } of params) bindings[name] = value;

  const dataQ = bindNamedParams(`
    SELECT rs.*, ${selectCols}
    FROM "RiskScores" rs
    ${fromClause}
    ${whereClause}
    ORDER BY rs."riskScore" DESC
    LIMIT @limit OFFSET @offset
  `, bindings);

  const countQ = bindNamedParams(`
    SELECT COUNT(*) AS total
    FROM "RiskScores" rs
    ${fromClause}
    ${whereClause}
  `, bindings);

  const dataResult  = await timedQuery(pool, `${label}-list`,  res, dataQ.text,  dataQ.values);
  const countResult = await timedQuery(pool, `${label}-count`, res, countQ.text, countQ.values);

  return {
    data:  dataResult.rows,
    total: countResult.rows[0].total,
  };
}
