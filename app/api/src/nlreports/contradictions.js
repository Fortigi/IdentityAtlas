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
export function contradictions(spec) {
  const found = [];
  const walk = (conditions, match) => {
    const fields = andedFieldConditions(conditions, match);
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        if (fields[i].field !== fields[j].field) continue;
        const message = conflict(fields[i], fields[j]);
        if (message) found.push(message);
      }
    }
    for (const c of conditions ?? []) {
      if (c.type === 'group' || c.type === 'relation') walk(c.conditions, c.match);
    }
  };
  walk(spec?.conditions, spec?.match);
  return found;
}
