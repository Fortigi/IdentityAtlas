// Natural-language reports — definitions that can never match anything.
//
// A report whose conditions contradict each other runs perfectly well and
// returns nothing, and "nothing" is indistinguishable from a truthful answer.
// That is the worst failure this pipeline has. Asked whether an account had
// been added to or removed from any group in the last 180 days, the model built
//
//     Action is "Added"   AND   Action is "Removed"
//     Changed is more than 180 days ago
//
// and the reply was "nothing matches" — for an account with ten changes in that
// window. Two conditions on one field that cannot both hold, joined by AND, and
// a time window pointing the wrong way. Neither the query nor the card had any
// way to know.
//
// WHY THIS IS NOT A COMPILER CONCERN. The SQL is correct: it faithfully asks an
// impossible question. The mistake is in the definition, so it is caught where
// definitions are checked, and reported as a validation error — which puts it
// straight into the repair round that already exists (nlreports/service.js,
// repairInvalidSpec), where the model is shown what is wrong and writes it
// again. If the second attempt is still impossible the report is refused rather
// than run, because a stated failure beats a false "no".
//
// LANGUAGE-INDEPENDENT ON PURPOSE. The pipeline also has a repair for "X or Y"
// built as "X and Y" (needsOrRepair), and that one reads the question — which
// is why it did nothing here: the question was Dutch. This reads only the
// definition, so it works the same in every language, including ones nobody
// thought about.
//
// THE SECOND SHAPE, from the held-out evaluation. Asked for "groups without
// owners that have more than 5 members", the model built
//
//     Owner count is more than 0   AND   has no owner   AND   Member count > 5
//
// — a count field and the relation it counts, pulling opposite ways. The
// catalog says which relation a count field counts (`counts:` on the field),
// so this is caught the same way, and the model is told which of the two to
// keep.

import { ENTITIES } from './catalog.js';
import { ME } from './caller.js';

const DAY_WINDOW = { withinLastDays: 'within', olderThanDays: 'older' };

/** Conditions that sit at the same level and must ALL hold. */
function andedFieldConditions(conditions, match) {
  if (match === 'any') return [];
  return (conditions ?? []).filter(c => c.type === 'field');
}

/** Both of these on one field, ANDed, can never be true at once. */
function conflictBetween(a, b) {
  const label = `"${a.field}"`;

  if (a.op === 'eq' && b.op === 'eq' && !sameValue(a.value, b.value)) {
    return `${label} cannot be both ${show(a.value)} and ${show(b.value)} at the same time`
      + ' — if either one will do, put them in a group with match "any"';
  }
  if (a.op === 'eq' && b.op === 'neq' && sameValue(a.value, b.value)) {
    return `${label} cannot be ${show(a.value)} and not ${show(b.value)} at the same time`;
  }
  if (a.op === 'isEmpty' && b.op === 'isNotEmpty') {
    return `${label} cannot be empty and not empty at the same time`;
  }
  // "within the last 30 days" and "more than 7 days ago" is a real window
  // (between 7 and 30 days back). It is only impossible when the older bound
  // reaches past the recent one.
  if (DAY_WINDOW[a.op] === 'within' && DAY_WINDOW[b.op] === 'older' && Number(b.value) >= Number(a.value)) {
    return `${label} cannot be within the last ${a.value} days and also more than ${b.value} days ago`
      + ' — for "in the last N days" use withinLastDays only';
  }
  return null;
}

const sameValue = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const show = (v) => (typeof v === 'string' ? `"${v}"` : String(v));

/** conflictBetween, tried both ways round, so order in the list does not matter. */
const conflict = (a, b) => conflictBetween(a, b) ?? conflictBetween(b, a);

/** What a number condition on a count forces: none at all, at least one, or neither. */
export function countSays(c) {
  const n = Number(c.value);
  if ((c.op === 'eq' && n === 0) || (c.op === 'lt' && n <= 1)) return 'zero';
  if ((c.op === 'gt' && n >= 0) || (c.op === 'neq' && n === 0)) return 'some';
  return null;
}

/**
 * A count field and the relation it counts, at one AND level, that cannot both
 * hold. "owner count above zero" with "has no owner at all" is one; "member
 * count is zero" with "has a member (matching anything)" is the other. A
 * relation with conditions under quantifier none is left alone: "has owners,
 * none of them called Jan" is a real report.
 */
function countConflicts(conditions, match, entity) {
  if (match === 'any' || !entity) return [];
  const found = [];
  const all = conditions ?? [];
  for (const c of all.filter(x => x.type === 'field')) {
    const counted = entity.fields?.[c.field]?.counts;
    const says = counted ? countSays(c) : null;
    if (!says) continue;
    for (const r of all.filter(x => x.type === 'relation' && x.relation === counted)) {
      if (says === 'some' && r.quantifier === 'none' && !(r.conditions?.length)) {
        found.push(`"${c.field}" above zero and "${r.relation}" none cannot both hold`
          + ` — for "without ${r.relation}" keep only the relation with quantifier none; for "with ${r.relation}" keep only "${c.field}" gt 0`);
      }
      if (says === 'zero' && r.quantifier !== 'none') {
        found.push(`"${c.field}" of zero and "${r.relation}" some cannot both hold — keep one of them`);
      }
    }
  }
  return found;
}

/**
 * Every way this definition contradicts itself.
 *
 * Walks each AND level separately — the top level and each `match: "all"`
 * group. Conditions inside a relation are ANDed against each other too, but
 * against the SUBJECT of that relation ("is in a group that is both X and Y"),
 * so they are checked as their own level rather than against the outer ones.
 *
 * @param {object} spec  a spec that has already passed field validation
 * @returns {string[]} one message per conflict, empty when it is satisfiable
 */
/**
 * The same relation required to have AND not have the same records, at one
 * AND level: "members some William" beside "members none William". Asked for
 * "the groups I am in that william is not", the model wrote william on both
 * sides. The message says what the one sensible fix is, because the repair
 * round is fed exactly this text.
 */
function relationConflicts(conditions, match) {
  if (match === 'any') return [];
  const relations = (conditions ?? []).filter(c => c.type === 'relation');
  const found = [];
  for (const some of relations.filter(c => c.quantifier !== 'none')) {
    for (const none of relations.filter(c => c.relation === some.relation && c.quantifier === 'none')) {
      if (JSON.stringify(some.conditions ?? []) !== JSON.stringify(none.conditions ?? [])) continue;
      const what = (some.conditions ?? []).map(c => show(c.value)).join(', ') || 'anything';
      found.push(`"${some.relation}" cannot both have and not have the same records (${what}) at the same time`
        + ` — one of the two conditions must be about somebody else (the person asking is id ${ME}, when the request says "I" or "my")`);
    }
  }
  return found;
}

export function contradictions(spec) {
  const found = [];
  const walk = (conditions, match, entity) => {
    found.push(...countConflicts(conditions, match, entity));
    found.push(...relationConflicts(conditions, match));
    const fields = andedFieldConditions(conditions, match);
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        if (fields[i].field !== fields[j].field) continue;
        const message = conflict(fields[i], fields[j]);
        if (message) found.push(message);
      }
    }
    for (const c of conditions ?? []) {
      // A relation's conditions are about its target: the count fields in
      // play there are the target's.
      if (c.type === 'group') walk(c.conditions, c.match, entity);
      if (c.type === 'relation') walk(c.conditions, c.match, ENTITIES[entity?.relations?.[c.relation]?.target]);
    }
  };
  walk(spec?.conditions, spec?.match, ENTITIES[spec?.entity]);
  return found;
}
