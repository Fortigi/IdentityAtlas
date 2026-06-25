import { timedRequest } from '../perf/sqlTimer.js';

/**
 * Runs a paginated data + count query against RiskScores with a caller-supplied
 * JOIN and WHERE clause. Returns { data: recordset[], total: number }.
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
  params,       // [{ name, value }] — bound to both data and count requests
  limit,
  offset,
}) {
  const dataReq  = timedRequest(pool, `${label}-list`,  res);
  const countReq = timedRequest(pool, `${label}-count`, res);

  for (const { name, value } of params) {
    dataReq.input(name, value);
    countReq.input(name, value);
  }
  dataReq.input('limit',  limit);
  dataReq.input('offset', offset);

  const dataResult = await dataReq.query(`
    SELECT rs.*, ${selectCols}
    FROM "RiskScores" rs
    ${fromClause}
    ${whereClause}
    ORDER BY rs."riskScore" DESC
    LIMIT @limit OFFSET @offset
  `);

  const countResult = await countReq.query(`
    SELECT COUNT(*) AS total
    FROM "RiskScores" rs
    ${fromClause}
    ${whereClause}
  `);

  return {
    data:  dataResult.recordset,
    total: countResult.recordset[0].total,
  };
}
