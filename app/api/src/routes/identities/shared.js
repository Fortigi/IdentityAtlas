// Shared helpers + runtime config for the identities endpoints.
//
// Extracted from routes/identities.js (audit finding C1) so the split
// sub-routers share one definition. enrichMembers stays exported (and is
// re-exported by routes/identities.js) for identities.enrich.test.js.

export const useSql = process.env.USE_SQL === 'true';

export let db = null;
if (useSql) {
  db = await import('../../db/connection.js');
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function hasTable(_pool, tableName) {
  const r = await db.queryOne(
    `SELECT to_regclass($1) AS t`,
    [`public."${tableName}"`]
  );
  return !!r?.t;
}

// Attach per-account group counts + risk to each linked-account member, keyed by
// `principalId` — the column every source query selects. A prior version keyed
// these maps by `userId` (which none of the queries return), so group counts
// always rendered 0 and risk/tier never attached on the identity-detail page.
// Pure + exported for unit testing (identities.enrich.test.js).
export function enrichMembers(members, riskRows = [], groupCountRows = []) {
  const riskMap = {};
  for (const r of riskRows) riskMap[r.principalId] = { riskScore: r.riskScore, riskTier: r.riskTier };
  const groupCountMap = {};
  for (const gc of groupCountRows) groupCountMap[gc.principalId] = gc.groupCount;
  for (const member of members) {
    member.groupCount = groupCountMap[member.principalId] || 0;
    const risk = riskMap[member.principalId];
    if (risk) {
      member.riskScore = risk.riskScore;
      member.riskTier = risk.riskTier;
    }
  }
  return members;
}
