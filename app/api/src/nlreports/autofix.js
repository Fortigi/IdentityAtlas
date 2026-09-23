// Natural-language reports — mistakes with exactly one sensible reading, put
// right here instead of by a second model round.
//
// On the hardware this runs on the model writes about one token a second, so a
// repair round — the model shown its mistake and asked for the whole definition
// again — costs one to three minutes, and the answer it comes back with is not
// reliably better: asked to fix "Added AND Removed", it dropped Removed and the
// 90-day window with it. Where the mistake has only one sensible correction,
// the correction is applied here, said out loud in the report's assumptions,
// and the model is not asked again.
//
// What is corrected, and why each is safe:
//
//   - two "is" conditions on one field, ANDed → the same two as alternatives.
//     "action is Added AND action is Removed" cannot match; as "either" it is
//     the question that was asked. (contradictions.js is what finds this.)
//   - a count above zero beside "has none of them" → the count goes. "owner
//     count > 0 AND no owner" came from a question about groups WITHOUT owners;
//     the relation is the reading, the count was the slip.
//   - "within the last N days" beside "more than M days ago", M ≥ N → the older
//     bound goes. Both came from one phrase ("in the last 90 days"), and only
//     the recent bound says what it said.
//   - a groupBy when the request never asked for counts → the grouping goes.
//     The model reads "which groups …" as "count per group" once in four hard
//     questions and answers "5" where five names were wanted.
//
// What is NOT corrected: "empty AND not empty", "count is zero AND has one" —
// two readings, so the model is asked. And nothing here looks at the data.

import { ENTITIES } from './catalog.js';
import { countSays } from './contradictions.js';

// The words a request uses when it wants counts per value rather than a list.
// Deliberately generous: a grouping the request DID ask for and this rule
// removed would be worse than one it let through.
const COUNT_WORDS = /\b(hoeveel|aantal|aantallen|per|gegroepeerd|groepeer|groeperen|verdeling|verdeeld|telling|tel|uniek|unieke|how many|count|counts|counted|number of|grouped|group by|breakdown|distribution|unique|distinct|tally)\b/i;

/** Does the request ask for counts per value ("how many users per department")? */
export function asksForCounts(question) {
  return COUNT_WORDS.test(String(question ?? ''));
}

/**
 * A groupBy the request never asked for is removed.
 * @returns {{ spec: object, notes: string[] }}
 */
export function dropUnaskedGrouping(spec, question) {
  if (!spec?.groupBy || asksForCounts(question)) return { spec, notes: [] };
  const { groupBy, ...rest } = spec;
  return { spec: rest, notes: [`Listed the records themselves, not a count per ${groupBy}: the request did not ask for counts.`] };
}

const show = (v) => (typeof v === 'string' ? `"${v}"` : String(v));
const isField = (c) => c?.type === 'field';

/** Two or more "is" conditions on one field become one "any" group of them. */
function mergeSameFieldEquals(list, notes) {
  const byField = new Map();
  for (const c of list) {
    if (isField(c) && c.op === 'eq') byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
  }
  const out = [];
  const merged = new Set();
  for (const c of list) {
    const group = isField(c) && c.op === 'eq' ? byField.get(c.field) : null;
    if (!group || group.length < 2 || new Set(group.map(g => String(g.value).toLowerCase())).size < 2) { out.push(c); continue; }
    if (merged.has(c.field)) continue;
    merged.add(c.field);
    out.push({ type: 'group', match: 'any', conditions: group });
    notes.push(`Read ${c.field} ${group.map(g => show(g.value)).join(' and ')} as alternatives — either one.`);
  }
  return out;
}

/** A count above zero beside the same relation with quantifier none: the count goes. */
function dropCountsAgainstRelations(list, entity, notes) {
  if (!entity) return list;
  const noneOf = new Set(list.filter(c => c.type === 'relation' && c.quantifier === 'none' && !(c.conditions?.length)).map(c => c.relation));
  return list.filter((c) => {
    const counted = isField(c) ? entity.fields?.[c.field]?.counts : null;
    if (!counted || !noneOf.has(counted) || countSays(c) !== 'some') return true;
    notes.push(`Dropped "${c.field} ${c.op} ${show(c.value)}": the request is about records with no ${counted}.`);
    return false;
  });
}

/** "within the last N days" beside "more than M days ago" with M ≥ N: the older bound goes. */
function dropReversedWindows(list, notes) {
  const recent = new Map(list.filter(c => isField(c) && c.op === 'withinLastDays').map(c => [c.field, Number(c.value)]));
  return list.filter((c) => {
    if (!isField(c) || c.op !== 'olderThanDays' || !recent.has(c.field) || Number(c.value) < recent.get(c.field)) return true;
    notes.push(`Dropped "${c.field} more than ${c.value} days ago": the request asks for the last ${recent.get(c.field)} days.`);
    return false;
  });
}

/**
 * Apply every safe correction to a validated definition.
 *
 * Works on the shape validateSpec() hands back (every condition typed), and
 * returns the same object when nothing was changed, so a caller can tell.
 *
 * @param {object} spec  a normalised definition, possibly one validation rejected
 * @returns {{ spec: object, notes: string[] }}
 */
export function autofixSpec(spec) {
  const notes = [];
  const fix = (conditions, match, entity) => {
    let list = conditions ?? [];
    if (match !== 'any') {
      list = mergeSameFieldEquals(list, notes);
      list = dropCountsAgainstRelations(list, entity, notes);
      list = dropReversedWindows(list, notes);
    }
    return list.map((c) => {
      if (c.type === 'group') return { ...c, conditions: fix(c.conditions, c.match, entity) };
      if (c.type === 'relation') return { ...c, conditions: fix(c.conditions, c.match, ENTITIES[entity?.relations?.[c.relation]?.target]) };
      return c;
    });
  };
  const conditions = fix(spec?.conditions, spec?.match, ENTITIES[spec?.entity]);
  return { spec: notes.length ? { ...spec, conditions } : spec, notes };
}

/**
 * Every "field op value" leaf of a definition, so two definitions can be
 * compared for what one dropped. Relations and groups are looked through;
 * the leaf keeps no record of where it sat.
 */
export function leaves(spec) {
  const out = new Set();
  const walk = (conditions) => {
    for (const c of conditions ?? []) {
      if (c.type === 'field') out.add(`${c.field} ${c.op} ${JSON.stringify(c.value ?? null)}`);
      else if (c.type === 'relation') { out.add(`${c.relation} ${c.quantifier}`); walk(c.conditions); } else if (c.type === 'group') walk(c.conditions);
      else if (c.type === 'compare') out.add(`compare ${c.relation} ${c.measure}`);
    }
  };
  walk(spec?.conditions);
  return out;
}

/**
 * The leaves a correction removed although no error named their field.
 *
 * A repair round is allowed to change what was wrong and nothing else. The
 * model does not honour that reliably — asked to fix one condition it rewrites
 * the definition and loses another — so what it dropped is checked against
 * what it was told, and a correction that lost more is refused.
 *
 * @returns {string[]} the leaves lost, empty when the correction stayed in bounds
 */
export function lostLeaves(before, after, errors) {
  const named = errors.join(' ');
  return [...leaves(before)].filter(leaf => !leaves(after).has(leaf) && !named.includes(`"${leaf.split(' ')[0]}"`));
}
