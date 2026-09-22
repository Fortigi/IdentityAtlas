// Teams bot (POC) — the one thing a chat does that a report builder cannot.
//
// "Van welke groepen ben ik owner?" … "en zijn die onderdeel van een access
// package?" The second question is not answerable on its own: "die" refers to
// 27 groups that exist only in the answer above it. Without this module the bot
// is a slower report builder with a chat skin — every question starts from
// nothing, and the follow-up that feels most natural is the one it cannot take.
//
// HOW THE REFERENCE IS RESOLVED. Not by asking the model to reason about the
// previous definition — composing a new definition out of an old one is a much
// harder task than writing a fresh one, and this runs on a 4B model. Instead
// the ids of what the caller was just shown are carried forward, and the model
// only has to notice that the question refers to them and write `@previous`.
// That turns composition back into ordinary interpretation, which is the thing
// the generator is measured at.
//
// WHAT THIS DOES NOT DO. It is not conversation memory. Exactly one answer is
// remembered per chat, it is replaced by the next one, and it expires. The
// follow-up can only NARROW to records the caller has already been shown, so it
// cannot widen what they can see — which matters, because the POC has no
// per-caller scope filter behind it (see caller.callerScopeFilter).

import { PREVIOUS_SENTINEL } from '../nlreports/spec.js';
import { MAX_IN_VALUES } from '../nlreports/spec.js';
import { substituteValues } from './specValues.js';

/**
 * How many records a follow-up may inherit.
 *
 * Capped well under the catalog's own list limit: a chat answer that ran to
 * hundreds of records is one the caller cannot have read, so "these groups"
 * would not mean anything definite to them either. Past this the bot carries
 * nothing rather than carrying a set the caller never saw.
 */
export const MAX_CARRIED = Math.min(200, MAX_IN_VALUES);

/** What an entity kind is called when telling the model what is on offer. */
const KIND_NOUN = {
  resource: 'groups / applications (the resource entity)',
  user: 'accounts (the account entity)',
  identity: 'people (the identity entity)',
};

/**
 * The records an answer actually put in front of the caller.
 *
 * Which records those are depends on the shape of the answer, and both shapes
 * are common:
 *
 *   - MANY ROWS. One row per group: the answer is about the rows themselves, so
 *     the rows' own records are what "these" means.
 *   - ONE ROW, MANY NAMES. "Van welke groepen ben ik owner?" answers with a
 *     single row — the caller's account — carrying a cell that lists 27 groups.
 *     The row is a container; the 27 groups are what the caller is looking at
 *     and what they will ask about next.
 *
 * So: the rows' own records when there is more than one row, otherwise the
 * largest list inside the single row. Anything else (a one-row answer that
 * lists nothing) carries nothing, which is correct — there is no set to refer
 * back to.
 *
 * @param {{rows?: object[]}} result  a runSpec result
 * @returns {{kind: string, records: {id: string, name: string|null}[]}|null}
 */
export function carriedRecords(result) {
  const rows = result?.rows ?? [];
  if (rows.length === 0) return null;

  const fromRows = rows.map(r => r._entity).filter(e => e?.kind && e?.id);
  if (rows.length > 1 && fromRows.length) {
    return capped(fromRows[0].kind, fromRows.map(e => ({ id: e.id, name: e.name ?? null })));
  }

  const lists = rows.flatMap(r => Object.values(r._links ?? {}));
  const biggest = lists.reduce((best, l) => (l.length > (best?.length ?? 0) ? l : best), null);
  if (biggest?.length && biggest[0].kind) {
    return capped(biggest[0].kind, biggest.map(l => ({ id: l.id, name: l.name ?? null })));
  }
  // A single row with nothing listed on it: the answer is that one record.
  return fromRows.length ? capped(fromRows[0].kind, [{ id: fromRows[0].id, name: null }]) : null;
}

/** Distinct by id, and never more than the cap. */
function capped(kind, records) {
  const seen = new Map();
  for (const r of records) if (!seen.has(r.id)) seen.set(r.id, r);
  if (seen.size > MAX_CARRIED) return null;
  return { kind, records: [...seen.values()] };
}

/**
 * What the model is told about the answer before this question.
 *
 * Deliberately narrow. It says the set exists, how big it is, and the exact
 * token to write — and then says when NOT to write it, because the failure that
 * matters is not a missed follow-up (the caller rephrases) but an unrelated
 * question being silently narrowed to 27 groups it was never about.
 *
 * @param {{kind: string, records: object[]}|null} carried
 * @returns {string} '' when there is nothing to carry
 */
export function previousContextBlock(carried) {
  if (!carried?.records?.length) return '';
  const noun = KIND_NOUN[carried.kind] ?? 'records';
  return [
    `The previous answer in this chat listed ${carried.records.length} ${noun}.`,
    `If — and only if — this question refers back to them ("these groups", "deze groepen", "those", "die", "daarvan", "of them"),`,
    `write ${PREVIOUS_SENTINEL} as the value of an "in" condition on the id field:`,
    `{"type":"field","field":"id","op":"in","value":"${PREVIOUS_SENTINEL}"}.`,
    `If the question stands on its own, ignore this and do not use ${PREVIOUS_SENTINEL}.`,
  ].join(' ');
}

/**
 * Replace `@previous` with the ids of what the caller was just shown.
 *
 * @param {object} spec  a definition straight from the model
 * @param {{records: {id: string}[]}|null} carried
 * @returns {object} the definition with the sentinel resolved
 */
export function substitutePrevious(spec, carried) {
  const ids = carried?.records?.map(r => r.id) ?? [];
  if (!ids.length) return spec;
  return substituteValues(spec, new Map([[PREVIOUS_SENTINEL, ids]]));
}

/** Did this definition actually pick the earlier answer up? */
export function usedPrevious(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}
