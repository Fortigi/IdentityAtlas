// Shared config + helpers for the risk-scores endpoints.
//
// Extracted from routes/riskScores.js (audit finding C1) so the list and
// entity/override sub-routers share one definition. No behaviour change —
// pure code move.

import { timedRequest } from '../../perf/sqlTimer.js';

export const useSql = process.env.USE_SQL === 'true';

export let db = null;
if (useSql) {
  db = await import('../../db/connection.js');
}

// Cached check for RiskScores table existence
let _riskTableExists = null;
let _riskTableCheckedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function riskTableExists(pool, res) {
  const now = Date.now();
  if (_riskTableExists !== null && (now - _riskTableCheckedAt) < CACHE_TTL_MS) {
    return _riskTableExists;
  }
  try {
    const result = await timedRequest(pool, 'risk-table-check', res).query(`
      SELECT to_regclass('"RiskScores"') AS tbl
    `);
    _riskTableExists = result.recordset[0].tbl != null;
  } catch {
    _riskTableExists = false;
  }
  _riskTableCheckedAt = now;
  return _riskTableExists;
}

// Parse JSON columns and compute effective score.
// In v5 these are jsonb columns — pg returns them already-parsed, so we only
// need JSON.parse when the value is a legacy string.
export function parseJsonColumns(row) {
  const r = { ...row };
  const cm = r.riskClassifierMatches;
  r.classifierMatches = (cm && typeof cm === 'string')
    ? (() => { try { return JSON.parse(cm); } catch { return []; } })()
    : (cm || []);
  delete r.riskClassifierMatches;

  const exp = r.riskExplanation;
  r.explanation = (exp && typeof exp === 'string')
    ? (() => { try { return JSON.parse(exp); } catch { return null; } })()
    : (exp || null);
  delete r.riskExplanation;

  r.riskOverride = r.riskOverride ?? null;
  r.riskOverrideReason = r.riskOverrideReason ?? null;
  r.effectiveScore = r.riskOverride != null
    ? Math.max(0, Math.min(100, (r.riskScore || 0) + r.riskOverride))
    : r.riskScore;

  return r;
}

// In v5 (postgres) temporal tables are gone, so the ValidTo filter is a no-op.
// Constant kept so all the JOIN clauses that reference it still compile.
export const TEMPORAL_FILTER = "1=1";
