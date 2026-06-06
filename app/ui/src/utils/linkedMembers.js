// Helpers for reasoning about an identity's linked accounts (IdentityMembers).

/**
 * A linked account is "source-linked" when it has no confidence score: it came
 * from the crawler / source data, is authoritative, and is owned by the crawler
 * — not by account linking. The identity UI shows "Linked from source" for these
 * and does NOT offer Confirm / Remove (those apply only to account-linking's
 * scored links). Mirrors the backend rule that a crawler reconcile leaves
 * score-bearing links alone.
 *
 * @param {{linkConfidence?: number|null}} member
 * @returns {boolean}
 */
export function isSourceLinkedMember(member) {
  return member == null || member.linkConfidence == null;
}
