// Context interviews — does a claim say the person left?
//
//   leftSignal(claim)   → true | false
//   saysLeft(text)      → true | false
//
// A small model does not always say "left" with a membership claim: "Bram did
// that too but recently left" comes back as a roleHistory claim with the value
// "left", "Ruud and Kees worked on it but have since left" as a roleHistory
// "worked" with the period "inmiddels uitgestroomd". So a claim says the person
// is not in it any more when it is:
//
//   membership           with the status former or left
//   role / roleHistory   whose value or periodText says so (LEFT_RE): left, no
//                        longer, former(ly), quit, departed, moved on; uitgestroomd,
//                        vertrokken, weg, niet meer, gestopt, voormalig(e), oud-…
//                        — except a notOwner claim ("no longer the owner" gives up
//                        the role, not the context), and one sentences.js corrected
//                        (CORRECTED_CURRENT in its value: the sentence says current)
//
// Words are matched whole ("weg" is not "wegwerken", "left" not "leftover"). Pure.

export const GONE_STATUSES = Object.freeze(['former', 'left']);
// The mark sentences.js puts in a claim's value when the sentence says the person
// is in it now: such a claim says nothing about leaving, whatever its words.
export const CORRECTED_CURRENT = 'corrected: the sentence says current';

const LEFT_RE = /(?<![\p{L}\p{N}])(?:left|no longer|former(?:ly)?|quit|departed|moved on|uitgestroomd|vertrokken|weg|niet meer|gestopt|voormalige?)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])oud-\p{L}/iu;

/** Does the text say someone left? */
export function saysLeft(text) {
  return LEFT_RE.test(String(text ?? ''));
}

/** Does the claim say the person is not in it any more? */
export function leftSignal(claim) {
  if (!claim) return false;
  if (claim.claimKind === 'membership') return GONE_STATUSES.includes(claim.attribute);
  if (claim.claimKind !== 'role' && claim.claimKind !== 'roleHistory') return false;
  // "I'm no longer the owner" gives up a role, not the context.
  if (claim.attribute === 'notOwner') return false;
  if (String(claim.value ?? '').includes(CORRECTED_CURRENT)) return false;
  return saysLeft(claim.value) || saysLeft(claim.periodText);
}
