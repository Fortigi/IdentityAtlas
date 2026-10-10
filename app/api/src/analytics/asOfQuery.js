// principals.countAsOf — account stock at the end of each month, reconstructed
// from the `_history` audit log (historyMethod 'reconstructed').
//
// The as-of state comes from the matrix timeline's CTE (matrix/scopeHistory.js
// asofSurrogateCte): prevData of the first event after D, else the live row.
// On top of it this applies three rules that CTE does not:
//
//   1. Tombstones are not alive: `state->>'deletedAt' IS NULL`. A soft delete is
//      an UPDATE in _history, so without this a deleted account keeps counting.
//   2. A system that had not been loaded yet at D contributes nothing. Since
//      migration 073 an initial load writes one anchor event per (table, system)
//      instead of per-row inserts; rows of a system whose anchor is after D would
//      otherwise count as present before they arrived.
//   3. Group principals are not accounts, and the profile's source scope applies.
//
// A period whose end precedes the oldest retained Principals event cannot be
// reconstructed and is reported as unavailable, never estimated.

import { asofSurrogateCte } from '../matrix/scopeHistory.js';
import { GROUP_PRINCIPAL_TYPE } from '../lib/principalTypes.js';
import { initialLoadRowId } from '../ingest/initialLoad.js';
import { fieldStateSql } from './fields.js';
import { normalized, groupingClauses } from './sqlParts.js';

// `initial-load:<id>` — derived from the ingest helper so the two cannot drift.
const ANCHOR_PREFIX = initialLoadRowId('');

/**
 * The month-end instants to reconstruct, oldest first. The last period is the
 * running month, measured at `now` and flagged incomplete.
 */
export function monthPeriods(periods, now = new Date()) {
  const out = [];
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  for (let back = periods - 1; back >= 1; back--) {
    const start = new Date(Date.UTC(y, m - back, 1));
    const end = new Date(Date.UTC(y, m - back + 1, 1) - 1);
    out.push({ period: start.toISOString().slice(0, 7), periodEnd: end.toISOString(), periodComplete: true });
  }
  out.push({ period: now.toISOString().slice(0, 7), periodEnd: now.toISOString(), periodComplete: false });
  return out;
}

/** The oldest retained Principals event — the earliest instant history can answer for. */
export const HISTORY_START_SQL = `SELECT MIN("changedAt") AS start FROM "_history" WHERE "tableName" = 'Principals'`;

/**
 * Split periods into reconstructable and unavailable. The running month (now)
 * is always answerable from the live rows; a past period needs historyStart ≤ its end.
 */
export function classifyPeriods(periods, historyStart) {
  const available = [];
  const unavailable = [];
  for (const p of periods) {
    const ok = !p.periodComplete || (historyStart && new Date(p.periodEnd) >= historyStart);
    (ok ? available : unavailable).push(p);
  }
  return { available, unavailable };
}

/**
 * The statement for ONE instant. The as-of instant is bound last via the
 * returned `asofParam` marker so the caller runs it once per period.
 */
export function principalsAsOfSql({ dims, scope, maxRows, bind }) {
  const exprs = dims.map(({ field, dimension }) =>
    normalized(fieldStateSql(field, 'sp.state', bind), dimension.unknownLabel, bind));
  const g = groupingClauses(exprs);
  const scopeWhere = scope?.systemIds
    ? `AND (sp.state ->> 'systemId')::int = ANY(${bind(scope.systemIds)}::int[])` : '';
  const groupType = bind(GROUP_PRINCIPAL_TYPE);
  const anchorPrefix = bind(ANCHOR_PREFIX);
  const limit = bind(maxRows + 1);
  return `WITH ${asofSurrogateCte('asof_principals', 'Principals', 'Principals')},
  not_loaded AS (
    SELECT h."rowData" ->> 'systemId' AS sid
      FROM "_history" h
     WHERE h."tableName" = 'Principals' AND starts_with(h."rowId", ${anchorPrefix}) AND h."changedAt" > :ASOF:
  )
  SELECT ${g.select}
         COUNT(*)::int AS accounts
    FROM asof_principals sp
   WHERE (sp.state ->> 'deletedAt') IS NULL
     AND (sp.state ->> 'principalType' IS NULL OR sp.state ->> 'principalType' <> ${groupType})
     AND NOT EXISTS (SELECT 1 FROM not_loaded nl WHERE nl.sid = sp.state ->> 'systemId')
     ${scopeWhere}
   ${g.groupBy}
  HAVING COUNT(*) > 0
   ${g.orderBy}
   LIMIT ${limit}`;
}

/** Substitute the as-of marker with the next positional parameter. */
export function bindAsOf(sql, params) {
  return sql.replaceAll(':ASOF:', `$${params.length + 1}::timestamptz`);
}
