// Context interviews — how the members lists word what the interviews say about
// a person (the API's `interview: { role, left }` per member, and the previous
// members). Pure; the data comes ready from the API (contexts/interviews/
// memberFacts.js) — these only word it.

import { periodLabel, sourceLabel, CONFIRMED } from './claims.helpers';

export const LEFT_WORDS = { left: 'left', former: 'former member' };

/** "Interview: left (last month)" — the status, and when as said, else the period, else when it was said. */
export function leftFlagText(left) {
  const when = periodLabel(left) || `said ${left.interviewedAt}`;
  return `Interview: ${LEFT_WORDS[left.membershipStatus] || left.membershipStatus} (${when})`;
}

/** The tooltip of a claim fact: the quote and its source. */
export function factTitle(fact) {
  const source = sourceLabel(fact);
  return fact.quote ? `“${fact.quote}” — ${source}` : source;
}

/** "junior (early years) → Lead architect (now)": a person's roles there, oldest first. */
export function roleHistoryText(role) {
  return (role?.history || []).map(h => {
    const period = periodLabel(h);
    return period ? `${h.value} (${period})` : h.value;
  }).join(' → ');
}

/** The tooltip of the role cell: the history when there is more than one role, else the quote and source. */
export function roleTitle(role) {
  return (role.history?.length ?? 0) > 1 ? roleHistoryText(role) : factTitle(role);
}

/** A proposed claim reads as not yet known: dashed and italic; a confirmed one is plain. */
export function factClass(status) {
  return CONFIRMED.has(status) ? '' : 'italic border-b border-dashed border-gray-400 dark:border-gray-500';
}

/** "12 entitlements" | "none" — what an account or person still holds; null when not matched. */
export function entitlementText(n) {
  if (n === null || n === undefined) return null;
  if (n === 0) return 'none';
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'entitlement' : 'entitlements'}`;
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The earlier stint's roles, as one phrase: "Junior developer", "Junior → Developer"; '' for none. */
export function earlierRolesText(rejoined) {
  return (rejoined?.earlier || []).map(e => capitalize(e.value)).join(' → ');
}

/** "rejoined · earlier: Junior developer" — the marker on a current member who came back. */
export function rejoinedText(rejoined) {
  const earlier = earlierRolesText(rejoined);
  return earlier ? `rejoined · earlier: ${earlier}` : 'rejoined';
}

/** The marker's tooltip: what was said, by whom, and the earlier roles with their periods. */
export function rejoinedTitle(rejoined) {
  const periods = (rejoined.earlier || []).map(e => {
    const period = periodLabel(e);
    return period ? `${capitalize(e.value)} (${period})` : capitalize(e.value);
  });
  return [factTitle(rejoined), periods.length ? `Earlier: ${periods.join(' → ')}` : null].filter(Boolean).join('\n');
}

/** "Junior developer (earlier period)" — a previous-members row for the earlier stint. */
export function earlierStintText(person) {
  const role = earlierRolesText(person.rejoined);
  return role ? `${role} (earlier period)` : 'earlier period';
}

/** The DOM id of a member's row, so another list can point at it. */
export const memberRowId = (id) => `context-member-${id}`;
