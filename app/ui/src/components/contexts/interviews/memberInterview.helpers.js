// Context interviews — how the People overview words what the sources say about
// a person (the API's role / left / rejoined facts and the decision on a person,
// GET /api/contexts/:id/people). Pure; the data comes ready from the API
// (contexts/interviews/people.js, memberFacts.js) — these only word it.

import { periodLabel, sourceLabel, CONFIRMED } from './claims.helpers';

/** The tooltip of a claim fact: the quote and its source. */
export function factTitle(fact) {
  const source = sourceLabel(fact);
  return fact.quote ? `“${fact.quote}” — ${source}` : source;
}

/** A proposed claim reads as not yet known: dashed and italic; a confirmed one is plain. */
export function factClass(status) {
  return CONFIRMED.has(status) ? '' : 'italic border-b border-dashed border-gray-400 dark:border-gray-500';
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The earlier stint's roles, as one phrase: "Junior developer", "Junior → Developer"; '' for none. */
export function earlierRolesText(rejoined) {
  return (rejoined?.earlier || []).map(e => capitalize(e.value)).join(' → ');
}

/** What was said about coming back, by whom, and the earlier roles with their periods. */
export function rejoinedTitle(rejoined) {
  const periods = (rejoined.earlier || []).map(e => {
    const period = periodLabel(e);
    return period ? `${capitalize(e.value)} (${period})` : capitalize(e.value);
  });
  return [factTitle(rejoined), periods.length ? `Earlier: ${periods.join(' → ')}` : null].filter(Boolean).join('\n');
}

// ─── Marked former by a decision (the API's `decision`) ───────────────────
// A source said the person left, an analyst decided "the source is right", and
// the member list still lists them: the People overview shows them as Left
// (decided). The member list is not changed.

const day = (at) => (at ? String(at).slice(0, 10) : null);

/** "Decided by Ann, 2026-10-23: the interview is right — Klanten (upload) still lists them". */
export function decisionText(decision, stillListed = true) {
  const who = [decision.by, day(decision.at)].filter(Boolean).join(', ');
  const listed = stillListed ? ` — ${decision.overrides} still lists them` : '';
  return `Decided${who ? ` by ${who}` : ''}: the interview is right${listed}`;
}

/** The hint beside a decision while the source still lists the person. */
export const STILL_LISTED_HINT = 'Still listed in the source — remove it there or re-import without them.';
