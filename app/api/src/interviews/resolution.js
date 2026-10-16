// Identity Atlas Interviews — how a spoken mention becomes a linked entity.
//
//   mention ("Peter") → ranked candidates → a SUGGESTION at most → a HUMAN decision
//
// Two rules carry the design (docs/architecture/interviews.md, decision-principles B3):
//
// 1. Automation never confirms. A detector or the search may leave a mention
//    `unresolved`, `suggested` or `not_found`; only an analyst sets `confirmed`,
//    `rejected` or `deferred`.
// 2. A homonym stays ambiguous. Two "Peter"s are never narrowed to one by score alone;
//    only context support — exactly one of them inside the interview's team scope —
//    may turn the pair into a suggestion, and a suggestion is still not a confirmation.
//
// Match confidence (the search score) is stored on the resolution. It is NOT claim
// confidence (how sure we are the statement is true) and NOT the human decision.

import { RESOLUTION_STATES } from './contracts.js';

// A lone candidate scoring below this is shown, but not suggested.
export const SUGGEST_MIN_SCORE = 0.6;

export const AUTOMATIC_STATES = Object.freeze(['unresolved', 'suggested', 'not_found']);
export const HUMAN_STATES = Object.freeze(['confirmed', 'rejected', 'deferred']);

// States that name an entity, and states that must not.
const NEEDS_ENTITY = new Set(['suggested', 'confirmed', 'rejected']);

// Allowed moves. Everything is revisable — a later row supersedes, nothing is
// overwritten — but a few moves make no sense and are refused: a decision cannot go
// back to "the machine suggested this", and nothing moves to the state it is in,
// except `rejected` (rejecting a second candidate) and `suggested` (a better one).
const TRANSITIONS = {
  none: ['unresolved', 'suggested', 'not_found', 'confirmed', 'rejected', 'deferred'],
  unresolved: ['suggested', 'not_found', 'confirmed', 'rejected', 'deferred'],
  suggested: ['suggested', 'confirmed', 'rejected', 'deferred', 'not_found', 'unresolved'],
  rejected: ['rejected', 'confirmed', 'deferred', 'not_found', 'unresolved', 'suggested'],
  not_found: ['confirmed', 'deferred', 'unresolved', 'suggested'],
  deferred: ['confirmed', 'rejected', 'not_found', 'unresolved', 'suggested'],
  confirmed: ['rejected', 'deferred'],
};

/**
 * Decide what the search alone may say about a mention.
 * @param {{ id: string, score: number, inScope: boolean }[]} candidates ranked, best first
 * @returns {{ state: 'not_found'|'suggested'|'unresolved', entityId: string|null, score: number|null, reason: string }}
 */
export function classifyCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return { state: 'not_found', entityId: null, score: null, reason: 'no-candidates' };
  if (list.length === 1) {
    const [only] = list;
    return only.score >= SUGGEST_MIN_SCORE
      ? { state: 'suggested', entityId: only.id, score: only.score, reason: 'single-candidate' }
      : { state: 'unresolved', entityId: null, score: null, reason: 'weak-match' };
  }
  const inScope = list.filter(c => c.inScope);
  if (inScope.length === 1 && inScope[0].score >= SUGGEST_MIN_SCORE) {
    return { state: 'suggested', entityId: inScope[0].id, score: inScope[0].score, reason: 'only-candidate-in-scope' };
  }
  return { state: 'unresolved', entityId: null, score: null, reason: 'ambiguous' };
}

/**
 * Check one appended resolution against the mention's current state.
 * @param {string|null} current  the latest state, or null for a fresh mention
 * @param {{ state: string, origin: string, entityId?: string|null }} next
 * @returns {string|null} an error sentence, or null when the move is allowed
 */
export function checkTransition(current, next) {
  if (!RESOLUTION_STATES.includes(next.state)) return `state must be one of: ${RESOLUTION_STATES.join(', ')}`;
  if (next.origin !== 'analyst' && next.origin !== 'detector') return 'origin must be "analyst" or "detector"';
  if (next.origin === 'detector' && !AUTOMATIC_STATES.includes(next.state)) {
    return `Only an analyst can set "${next.state}"; a detector may set ${AUTOMATIC_STATES.join(', ')}`;
  }
  const hasEntity = typeof next.entityId === 'string' && next.entityId.length > 0;
  if (NEEDS_ENTITY.has(next.state) && !hasEntity) return `"${next.state}" needs the entityId it is about`;
  if (!NEEDS_ENTITY.has(next.state) && hasEntity) return `"${next.state}" must not name an entity`;
  const allowed = TRANSITIONS[current ?? 'none'];
  if (!allowed) return `Unknown current state "${current}"`;
  if (!allowed.includes(next.state)) return `A mention that is "${current}" cannot become "${next.state}"`;
  return null;
}
