// Context interviews — a member marked former by a decision (migration 101).
//
//   overrideAction(claim, status, merged)              → 'mark' | 'clear' | null   (pure)
//   applyMemberOverride(client, claim, decided, user)  → { overrides } | null
//   clearClaimOverride(client, claimId)                → rows removed
//   overriddenMemberCount(db, contextId)               → n
//
// An interview says a person left; the member list — its source: a sync, an
// upload, a rule, or kept by hand — still lists them. An analyst who decides
// "the interview is right" (confirms the claim as said, or edits it without
// giving a period) marks them FORMER here: one ContextMemberOverrides row on top
// of ContextMembers, never a change to it, because the source would add the row
// back on its next sync or re-import. With the row:
//
//   the members list   leaves them out of the current members (?includeOverridden
//                      shows them, flagged) and says how many it left out
//   Previous members   lists them with the decision: who, when, the source it
//                      overrides, and the entitlements they still hold
//   the unit report    marks them "marked former (decision)" rather than dropping them
//   the matrix         is unchanged: it shows access, and the access is still there
//
// The other decisions mark nobody: "the list is right" rejects the claim, and
// "both true, at different times" confirms it with a period — an earlier stint,
// the person is in it now. Confirming a claim that they are in it (current,
// joined, rejoined) clears the mark. Undoing the decision (decide.js undoClaim)
// or deleting the interview deletes it.
//
// Two functions are the only writers of ContextMemberOverrides — a hook on a mark
// being set or removed belongs in them: applyMemberOverride (sets or clears, from
// a decision) and clearClaimOverride (removes the mark a claim made, on undo).

import { leftSignal } from './leftSignal.js';
import { memberListName } from './contradictions.js';

const PERSON_KINDS = new Set(['role', 'roleHistory', 'membership']);
const PRESENT = new Set(['current', 'joined', 'rejoined']);
// The holder column a context of each kind of member is keyed by.
export const MEMBER_COLUMN = Object.freeze({ Principal: 'principalId', Identity: 'identityId' });

const hasPeriod = (c) => !!(c.periodFrom || c.periodTo || c.periodText);

/**
 * What a decision on a claim does to the mark: 'mark' (the interview is right
 * that they left), 'clear' (confirmed that they are in it), or null. `status`
 * is the claim's new status; `merged` its value and period as decided. Pure.
 */
export function overrideAction(claim, status, merged = {}) {
  if (!PERSON_KINDS.has(claim.claimKind) || status === 'rejected') return null;
  const decided = { ...claim, ...merged };
  if (claim.claimKind === 'membership' && PRESENT.has(claim.attribute)) return 'clear';
  if (!leftSignal(decided)) return null;
  // Both true, at different times: a stint in the past, not a former member now.
  return status === 'edited' && hasPeriod(decided) ? null : 'mark';
}

// The context, and whether the person is listed in it (by the source).
export const OVERRIDE_CONTEXT_SQL = `
    SELECT ctx."targetType", ctx.variant, s."displayName" AS "systemName",
           EXISTS (SELECT 1 FROM "ContextMembers" cm
                    WHERE cm."contextId" = ctx.id AND cm."memberId" = $2::uuid) AS "isListed"
      FROM "Contexts" ctx
      LEFT JOIN "Systems" s ON s.id = ctx."scopeSystemId"
     WHERE ctx.id = $1`;

export const UPSERT_OVERRIDE_SQL = `
    INSERT INTO "ContextMemberOverrides" ("contextId", "memberId", "claimId", overrides, "decidedBy")
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT ("contextId", "memberId")
    DO UPDATE SET "claimId" = EXCLUDED."claimId", overrides = EXCLUDED.overrides,
                  "decidedBy" = EXCLUDED."decidedBy", "decidedAt" = now()`;

export const DELETE_MEMBER_OVERRIDE_SQL = `DELETE FROM "ContextMemberOverrides" WHERE "contextId" = $1 AND "memberId" = $2`;
export const DELETE_CLAIM_OVERRIDE_SQL = `DELETE FROM "ContextMemberOverrides" WHERE "claimId" = $1`;

// The members still listed by their source that a decision marked former.
export const OVERRIDDEN_MEMBER_COUNT_SQL = `
    SELECT count(*)::int AS n
      FROM "ContextMemberOverrides" o
      JOIN "ContextMembers" cm ON cm."contextId" = o."contextId" AND cm."memberId" = o."memberId"
     WHERE o."contextId" = $1`;

/**
 * Mark or clear, inside the decision's transaction. Nobody is marked who is not
 * listed: the person must be a member of the context by its own kind (an account
 * of a unit of accounts, a person of a unit of people).
 * @param {{ query: Function }} client  the decision's transaction client
 * @param {object} claim                the claim as locked (contextId, id, claimKind, attribute, value, period)
 * @param {{ status: string, merged: object, holder: { col: string, id: string } | null }} decided
 *                                      the new status, the value / period as decided, the person
 * @param {string} [user]               who decided
 * @returns {Promise<{ overrides: string } | null>}  the source overridden when it marked the person former
 */
export async function applyMemberOverride(client, claim, { status, merged, holder }, user) {
  const action = overrideAction(claim, status, merged);
  if (!action || !holder) return null;
  const context = (await client.query(OVERRIDE_CONTEXT_SQL, [claim.contextId, holder.id])).rows[0];
  if (!context || MEMBER_COLUMN[context.targetType] !== holder.col) return null;
  if (action === 'clear') {
    await client.query(DELETE_MEMBER_OVERRIDE_SQL, [claim.contextId, holder.id]);
    return null;
  }
  if (!context.isListed) return null;
  const overrides = memberListName(context);
  await client.query(UPSERT_OVERRIDE_SQL, [claim.contextId, holder.id, claim.id, overrides, user ?? null]);
  return { overrides };
}

/**
 * Remove the former-member mark a claim's decision made — the undo of a decision.
 * @param {{ query: Function }} client  the transaction client (or the db)
 * @param {string} claimId              the claim whose decision is undone
 * @returns {Promise<number>}           how many marks were removed (0 or 1)
 */
export async function clearClaimOverride(client, claimId) {
  return (await client.query(DELETE_CLAIM_OVERRIDE_SQL, [claimId])).rowCount ?? 0;
}

export async function overriddenMemberCount(db, contextId) {
  return (await db.queryOne(OVERRIDDEN_MEMBER_COUNT_SQL, [contextId]))?.n ?? 0;
}
