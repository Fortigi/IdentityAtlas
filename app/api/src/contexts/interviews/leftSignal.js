// Context interviews — does a claim say the person left?
//
//   leftSignal(claim)   → true | false
//   saysLeft(text)      → true | false
//   returnSignal(claim) → true | false — the person came back (membership rejoined, or the words)
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
//   saysReturned(text)  → true | false — the person left and is back again:
//                        rejoined, came back, back as, returned, again; (weer) terug,
//                        teruggekomen, teruggekeerd, terug als / bij, kwam terug, is
//                        terug, opnieuw, weer bij / aan de slag, "is sinds … terug".
//                        A bare "terug" or "weer" is NOT enough: "een jaar terug" is
//                        "a year ago", "weer" is also the weather. A claim
//                        sentences.js corrected for this carries CORRECTED_RETURNED.
//
// Words are matched whole ("weg" is not "wegwerken", "left" not "leftover"). Pure.

export const GONE_STATUSES = Object.freeze(['former', 'left']);
// The mark sentences.js puts in a claim's value when the sentence says the person
// is in it now: such a claim says nothing about leaving, whatever its words.
export const CORRECTED_CURRENT = 'corrected: the sentence says current';
// The mark for a claim whose sentence says the person came back: in it now, after
// an earlier stint.
export const CORRECTED_RETURNED = 'corrected: the sentence says they came back';

const LEFT_RE = /(?<![\p{L}\p{N}])(?:left|no longer|former(?:ly)?|quit|departed|moved on|uitgestroomd|vertrokken|weg|niet meer|gestopt|voormalige?)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])oud-\p{L}/iu;

// "is sinds een half jaar terug" — "since half a year back": back, not "ago", by the "is".
const RETURN_RE = /(?<![\p{L}\p{N}])(?:re-?joined|came back|comes? back|coming back|back as|is back|are back|returned|joined again|back again|again as|weer terug|teruggekomen|teruggekeerd|terugkwam|kwamen? terug|is terug|zijn terug|terug als|terug bij|terug in|opnieuw|weer bij|weer aan de slag|weer in dienst)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:is|zijn) sinds(?![\p{L}\p{N}])[^.;!?]{0,60}?(?<![\p{L}\p{N}])terug(?![\p{L}\p{N}])/iu;

/** Does the text say someone left and came back? */
export function saysReturned(text) {
  return RETURN_RE.test(String(text ?? ''));
}

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
  const value = String(claim.value ?? '');
  if (value.includes(CORRECTED_CURRENT) || value.includes(CORRECTED_RETURNED)) return false;
  // "left in 2022 and came back as architect": in it now.
  if (saysReturned(value) || saysReturned(claim.periodText)) return false;
  return saysLeft(value) || saysLeft(claim.periodText);
}

/** Does the claim say the person came back — a membership 'rejoined', or words for it in its value or period? */
export function returnSignal(claim) {
  if (!claim) return false;
  if (claim.claimKind === 'membership') return claim.attribute === 'rejoined';
  if (claim.claimKind !== 'role' && claim.claimKind !== 'roleHistory') return false;
  return String(claim.value ?? '').includes(CORRECTED_RETURNED) || saysReturned(claim.value) || saysReturned(claim.periodText);
}
