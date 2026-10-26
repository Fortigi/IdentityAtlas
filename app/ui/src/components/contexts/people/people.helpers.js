// The People overview — the pure parts of showing it. The API
// (GET /api/contexts/:id/people, contexts/interviews/people.js) merges the
// members and the claims and decides each person's status; these only word and
// group what it sent.

import { decisionText, factTitle, rejoinedTitle, STILL_LISTED_HINT } from '@ui/components/contexts/interviews/memberInterview.helpers';

export const PEOPLE_FILTERS = [
  { key: 'current', label: 'Current' },
  { key: 'former', label: 'Former' },
  { key: 'all', label: 'All' },
];

// One status vocabulary, the API's.
export const STATUS_LABELS = {
  current: 'Current',
  cameBack: 'Came back',
  notConfirmed: 'Not confirmed',
  leftDecided: 'Left (decided)',
  left: 'Left',
};

// Status colours: green in it, teal back, grey dashed unknown, amber decided against the list, grey gone. Never blue (interactive only).
export const STATUS_CHIP = {
  current: 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300',
  cameBack: 'bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200',
  notConfirmed: 'border border-dashed border-gray-400 text-gray-700 dark:border-gray-500 dark:text-gray-300',
  leftDecided: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  left: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
};

const NOT_CONFIRMED_HINT = 'A source says they are in it, but the member list does not list them';

/** The status chip's tooltip: why the person has that status. Pure. */
export function statusTitle(person) {
  if (person.status === 'notConfirmed') return NOT_CONFIRMED_HINT;
  if (person.status === 'leftDecided' && person.decision) {
    return `${decisionText(person.decision, person.stillListed)}. ${STILL_LISTED_HINT}`;
  }
  if (person.status === 'cameBack' && person.rejoined) return rejoinedTitle(person.rejoined);
  if (person.status === 'left' && person.left) return factTitle(person.left);
  return undefined;
}

// Where what we know about a person comes from: the member list, an interview, a file, pasted notes.
export const SOURCE_CHIP_LABELS = { list: 'list', interview: 'interview', file: 'file', text: 'notes' };

/** The tooltip of a source chip; the list one names the list. Pure. */
export function sourceChipTitle(kind, listName) {
  if (kind === 'list') return `Listed by ${listName || 'the member list'}`;
  return { interview: 'Said in an interview', file: 'In a file someone added', text: 'In notes someone added' }[kind];
}

// The claim icons on a person's row: one per kind of claim.
export const CLAIM_GROUPS = [
  { key: 'role', kind: 'role', label: 'Role' },
  { key: 'membership', kind: 'membership', label: 'Membership' },
  { key: 'history', kind: 'roleHistory', label: 'History' },
];

/**
 * The person's claim icons: [{ key, label, claims, state }], a group per kind
 * that has claims; state 'proposed' while any of them is (outlined, dashed),
 * else 'confirmed' (solid). Pure.
 */
export function claimIcons(person) {
  const claims = person?.claims || [];
  return CLAIM_GROUPS
    .map(g => ({ ...g, claims: claims.filter(c => c.claimKind === g.kind) }))
    .filter(g => g.claims.length > 0)
    .map(g => ({ key: g.key, label: g.label, claims: g.claims, state: g.claims.some(c => c.status === 'proposed') ? 'proposed' : 'confirmed' }));
}

/** The open contradictions the person is in, in the API's order. Pure. */
export function personContradictions(person, contradictions) {
  const ids = new Set(person?.contradictions || []);
  return (contradictions || []).filter(c => ids.has(c.id) && c.status === 'open');
}

/** At most `n` characters, cut at the end with an ellipsis. Pure. */
export function truncate(text, n = 200) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** What a person still holds: "210", "0", or "–" when nobody was matched. Pure. */
export function accessText(n) {
  return n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US');
}

/** Which detail page the person's name opens: their account, else the person. Pure. */
export function personLink(person) {
  if (person.principalId) return { kind: 'user', id: person.principalId };
  if (person.identityId) return { kind: 'identity', id: person.identityId };
  return null;
}

/** "3 current · 4 former" — for the section's heading. Pure. */
export function countsLine(counts) {
  if (!counts) return '';
  return `${counts.current ?? 0} current · ${counts.former ?? 0} former`;
}
