// Context interviews — reading the former-member marks (memberOverrides.js,
// migration 099) beside member rows. No imports, so the members route and the
// previous-members read can use it without pulling in the deciding code.
//
//   OVERRIDE_JOIN / OVERRIDE_COLUMNS   for a read over ContextMembers cm
//   decisionOf(row)                    → { by, at, overrides, claimId } | null   (pure)
//   withOverride(row)                  → the row with `overridden` in place of the columns (pure)

export const OVERRIDE_JOIN = `LEFT JOIN "ContextMemberOverrides" o ON o."contextId" = cm."contextId" AND o."memberId" = cm."memberId"`;
export const OVERRIDE_COLUMNS = `o."claimId" AS "overrideClaimId", o.overrides AS "overrideSource", o."decidedBy" AS "overrideBy", o."decidedAt" AS "overrideAt"`;
const OVERRIDE_KEYS = ['overrideClaimId', 'overrideSource', 'overrideBy', 'overrideAt'];

/** The decision on a row that carries the override's columns, or null. Pure. */
export function decisionOf(row) {
  if (!row?.overrideClaimId) return null;
  return { by: row.overrideBy ?? null, at: row.overrideAt ?? null, overrides: row.overrideSource, claimId: row.overrideClaimId };
}

/** A member row with `overridden` (the decision, or null) in place of the override's columns. Pure. */
export function withOverride(row) {
  const out = { ...row, overridden: decisionOf(row) };
  for (const k of OVERRIDE_KEYS) delete out[k];
  return out;
}
