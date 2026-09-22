// Teams bot (POC) — turning "my" into the caller's own account.
//
// The model is told (caller.js, callerContextBlock) to write `@me` wherever a
// condition should match the person asking. This pass replaces that sentinel
// with their account id, before the definition reaches validateSpec().
//
// Why a sentinel and not just pasting the caller's uuid into the question: a
// 4B model copying a 36-character uuid back out of a prompt is a coin flip, and
// a SINGLE wrong character produces a definition that validates, runs, returns
// nothing, and looks exactly like "you have no direct reports". A sentinel is
// four characters it either wrote or did not, and this pass is what makes the
// id correct by construction rather than by luck.
//
// Why before validation rather than during it: `values` is threaded through
// every validator in spec.js as "the enum values that exist in this
// deployment", and adding a caller to that thread would mean touching eight
// functions to serve one caller. Substituting first keeps spec.js's job
// unchanged — what comes out of here is an ordinary definition with an ordinary
// uuid in it, and it is validated like any other. spec.js still rejects a
// surviving `@me`, so a definition that skipped this pass fails loudly instead
// of quietly matching nothing.

import { CALLER_SENTINEL } from '../nlreports/spec.js';
import { isUuid } from './caller.js';
import { substituteValues } from './specValues.js';

/**
 * Replace every `@me` in a report definition with the caller's account id.
 *
 * Structure-preserving and non-mutating: the input definition is the model's
 * output and is also what gets logged, so it is left exactly as it came.
 *
 * @param {unknown} node  a definition, a condition, or any value inside one
 * @param {string} callerPrincipalId  the caller's `Principals.id`
 * @returns {unknown} the same shape with the sentinel substituted
 */
export function substituteCaller(node, callerPrincipalId) {
  if (!isUuid(callerPrincipalId)) {
    throw new TypeError('substituteCaller needs a resolved caller account id');
  }
  return substituteValues(node, new Map([[CALLER_SENTINEL, callerPrincipalId]]));
}

/**
 * Did the model actually anchor this definition to the caller?
 *
 * Used for the interpretation line, not for rejection. A manager who asks
 * "which of my people can reach the finance site" and gets an answer covering
 * the WHOLE directory has been misled in the most expensive direction, and the
 * POC has no scope filter to catch it (see caller.callerScopeFilter). So when a
 * question sounds possessive and the definition never mentions the caller, the
 * card says so out loud rather than presenting the rows as if they were "yours".
 *
 * @param {object} spec  a definition, AFTER substitution
 * @param {string} callerPrincipalId
 * @returns {boolean}
 */
export function mentionsCaller(spec, callerPrincipalId) {
  return JSON.stringify(spec ?? null).includes(callerPrincipalId);
}

// First-person possessives in the two languages the bot answers in. Matched as
// whole words: "mine" must not fire on "mining", and "ik" must not fire on
// "ikea". Deliberately small — this only decides whether to add a caveat line.
const POSSESSIVE_RE = /\b(my|mine|i|me|mijn|mijne|ik|onze|ons)\b/i;

/** Does the question claim the answer is about the person asking? */
export function soundsPossessive(question) {
  return POSSESSIVE_RE.test(String(question ?? ''));
}

/**
 * Does this answer need the "not limited to you" caveat on its card?
 *
 * A predicate rather than the sentence itself, because the sentence is one of
 * the two the bot has to write in the caller's own language (text.js) and a
 * caveat that comes back in English on a Dutch card is the one place a reader
 * is most likely to skip it.
 *
 * @returns {boolean}
 */
export function needsScopeCaveat(question, spec, callerPrincipalId) {
  return soundsPossessive(question) && !mentionsCaller(spec, callerPrincipalId);
}
