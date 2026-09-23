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

import { MAX_CONDITIONS, MAX_IN_VALUES, PREVIOUS_SENTINEL } from './spec.js';
import { ENTITIES } from './catalog.js';
import { substituteValues } from './sentinels.js';

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

// ─── resolving the reference without the model ──────────────────────────────
//
// Asking the model to write `@previous` did not work, and the log says exactly
// why it is not a reasoning failure. Given "welke van deze groepen zitten in
// access packages?" the model produced entity `group` with a `businessRoles
// some` condition — the hard part, which needs knowing that an access package
// is a BusinessRole resource and which relation reaches it. What it left out
// was the bookkeeping: one extra condition, described once in a long English
// preamble, using an operator that appears nowhere in its system prompt.
//
// So the bookkeeping moves here. The model keeps the job it is measured at —
// what does the caller want to know — and "these groups" is resolved by code,
// from three facts the bot already holds: a set was carried, the question
// points back at it by name, and the definition is about the same kind of
// record. `@previous` stays supported for when the model does write it; this
// is the path that does not depend on it.

/** What a caller calls each kind of record when pointing back at it. */
const KIND_NOUNS = {
  resource: ['groep', 'groepen', 'group', 'groups', 'resource', 'resources',
    'applicatie', 'applicaties', 'application', 'applications'],
  user: ['account', 'accounts', 'gebruiker', 'gebruikers', 'user', 'users',
    'medewerker', 'medewerkers'],
  identity: ['persoon', 'personen', 'identiteit', 'identiteiten', 'people', 'identities', 'mensen'],
};

const DEMONSTRATIVES = ['deze', 'die', 'dat', 'these', 'those', 'genoemde'];

/** Phrases that cannot mean anything but "the answer above". */
const BACK_REFERENCES = ['daarvan', 'hiervan', 'bovenstaande', 'of these', 'of those', 'of them'];

/** How far after a demonstrative its noun may sit ("deze 29 groepen"). */
const NOUN_WINDOW = 3;

/**
 * Does this question point back at the previous answer?
 *
 * A demonstrative ALONE is not enough, and that is the whole design of this
 * function: "welke groepen zijn deze maand aangemaakt" contains "deze" and
 * refers to nothing. So a demonstrative only counts when a word naming the
 * carried kind follows it shortly after — "deze groepen", "those applications".
 *
 * The trade is deliberately biased. "En zijn die onderdeel van een access
 * package?" has no noun after "die" and is therefore MISSED, which costs the
 * caller a rephrase. Narrowing a question that was not about the earlier set
 * costs them a confident wrong answer they cannot see, so misses are the
 * direction to err in.
 */
export function refersToPrevious(question, kind) {
  const text = String(question ?? '').toLowerCase();
  if (BACK_REFERENCES.some(phrase => text.includes(phrase))) return true;

  const nouns = KIND_NOUNS[kind];
  if (!nouns) return false;
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((word, i) => DEMONSTRATIVES.includes(word)
    && words.slice(i + 1, i + 1 + NOUN_WINDOW).some(w => nouns.includes(w)));
}

/** The kind of detail page an entity's rows are, for comparing with a carried set. */
const entityKind = (entity) => (has(ENTITIES, entity) ? ENTITIES[entity].detailKind : null);
const has = (obj, key) => Object.hasOwn(obj, key);

/** Is the definition already limited to a set of ids, directly or through a relation? */
const alreadyNarrowed = (spec) => (spec.conditions ?? []).some(c => isIdList(c)
  || (c.type === 'relation' && (c.conditions ?? []).some(isIdList)));

const isIdList = (c) => c.field === 'id' && c.op === 'in';

/**
 * The condition that limits a report to the carried records.
 *
 * Two shapes, because a follow-up does not always ask about the same KIND of
 * thing as the answer before it:
 *
 *   - "welke van deze groepen zitten in access packages?" is about the groups
 *     themselves, so their ids go straight onto the report's own id field.
 *   - "zijn er recent leden aan deze groepen toegevoegd?" is about CHANGES,
 *     and a change is not a group. The ids belong on the relation that reaches
 *     one — `change.resource` — or the question narrows nothing and quietly
 *     reports on every change in the directory.
 *
 * Returns null when the entity has no way to reach the carried kind, which is
 * the right answer for a question that merely happens to contain the word.
 */
function limitFor(entity, carried) {
  const ids = carried.records.map(r => r.id);
  if (entityKind(entity) === carried.kind) return { type: 'field', field: 'id', op: 'in', value: ids };

  // Which relation carries the reference is DECLARED by the entity
  // (`narrowVia`), never inferred by looking for one whose target matches.
  // Several relations usually reach the same kind — a change has both
  // `account` and `manager` pointing at accounts, an account has both `owns`
  // and `memberOf` pointing at resources — so picking the first match would
  // make the meaning of "these groups" depend on declaration order, and turn
  // "who is in these groups" into "who owns them" without anyone noticing.
  const via = has(ENTITIES, entity) ? ENTITIES[entity].narrowVia : null;
  const relation = via && has(via, carried.kind) ? via[carried.kind] : null;
  if (!relation) return null;
  return {
    type: 'relation', relation, quantifier: 'some', match: 'all',
    conditions: [{ type: 'field', field: 'id', op: 'in', value: ids }],
  };
}

/**
 * The carried ids written INSIDE a relation whose records are not of their
 * kind, moved to the report's own id field.
 *
 * Asked "welke van deze groepen zijn onderdeel van een access package?", the
 * model wrote the 118 group ids on the members relation — a list of groups
 * where a list of accounts belongs — and nothing matched. It did the hard
 * part (this is a follow-up about those groups) and got the bookkeeping
 * wrong, so the bookkeeping is corrected. The list is recognised by its
 * contents, never by its shape alone: an id list the caller built is left
 * where it is.
 */
function relocateMisplaced(spec, carried) {
  if (entityKind(spec.entity) !== carried.kind) return spec;
  const ids = new Set(carried.records.map(r => r.id));
  const holdsCarried = (c) => isIdList(c) && Array.isArray(c.value) && c.value.length === ids.size && c.value.every(v => ids.has(v));
  let moved = false;
  const conditions = (spec.conditions ?? []).flatMap((c) => {
    if (c.type !== 'relation' || !(c.conditions ?? []).some(holdsCarried)) return [c];
    const target = has(ENTITIES, spec.entity) ? ENTITIES[spec.entity].relations?.[c.relation]?.target : null;
    if (target && entityKind(target) === carried.kind) return [c];
    moved = true;
    const rest = c.conditions.filter(x => !holdsCarried(x));
    return rest.length ? [{ ...c, conditions: rest }] : [];
  });
  if (!moved) return spec;
  return { ...spec, conditions: [...conditions, { type: 'field', field: 'id', op: 'in', value: [...ids] }] };
}

/**
 * Limit a definition to the records the previous answer produced.
 *
 * Returns the definition unchanged unless all four hold: something was carried,
 * the question points back at it, the definition is about the same kind of
 * record, and it is not already limited to a set of ids (which is what the
 * model writing `@previous` itself produces).
 */
export function narrowToPrevious(spec, carried, question) {
  if (!carried?.records?.length || !spec) return spec;
  spec = relocateMisplaced(spec, carried);
  if (!refersToPrevious(question, carried.kind)) return spec;
  if (alreadyNarrowed(spec)) return spec;

  const limit = limitFor(spec.entity, carried);
  if (!limit) return spec;
  const existing = spec.conditions ?? [];

  // ANDed with what the model wrote — but conditions joined by OR have to be
  // grouped first, or adding one more alternative would WIDEN the report to
  // every record matching it. Grouping also keeps the condition count legal
  // when the model already used the whole budget.
  const mustGroup = (spec.match === 'any' && existing.length > 1) || existing.length >= MAX_CONDITIONS;
  const conditions = mustGroup
    ? [{ type: 'group', match: spec.match === 'any' ? 'any' : 'all', conditions: existing }, limit]
    : [...existing, limit];

  return { ...spec, match: 'all', conditions };
}
