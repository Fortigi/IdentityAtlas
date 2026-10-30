// The unit report's organisational claims: per row, what the People overview
// (GET /api/contexts/:id/people) says about the person — their status, their
// role and where that came from — and the people the sources name whom the
// member list does not list (not confirmed, left), as rows of their own.
//
// One set of rules: every person is built by contexts/interviews/people.js
// exactly as the overview builds them (knownPeople, buildPerson); this module
// only reads the claims for a whole run and words a person for three cells.
// A reader without data.write.contexts (a context owner too) is answered from
// confirmed claims only — the route passes the statuses, as it does for the
// overview.
//
// Set-based: one read of every person claim of every unit the rows cover
// (store.personClaimsIn), and one holder read per unit PICKED (store.holderRows,
// the overview's own) — whatever the number of people.

import * as db from '../db/connection.js';
import * as store from '../contexts/interviews/store.js';
import { MEMBER_COLUMN } from '../contexts/interviews/memberOverrides.js';
import { buildPerson, groupClaimsByPerson, holderKey, splitByStatus, FORMER } from '../contexts/interviews/people.js';
import { knownPeople } from '../contexts/interviews/peopleLoad.js';

// Light amber: the claim columns set apart from what a connected system says.
export const CLAIM_HEADER_FILL = 'FFFEF3C7';
export const CLAIM_COLUMNS = Object.freeze([
  { key: 'claimStatus', label: 'Org claim — Status', headerFill: CLAIM_HEADER_FILL },
  { key: 'claimRole', label: 'Org claim — Role', headerFill: CLAIM_HEADER_FILL },
  { key: 'claimSource', label: 'Org claim — Source', headerFill: CLAIM_HEADER_FILL },
]);

export const CLAIM_NOTE = "Columns marked 'Org claim' come from what people told us (interviews, notes and other "
  + "added information), not from a connected system. '(proposed)' means not reviewed yet.";

// The People overview's words for its statuses (the UI's STATUS_LABELS).
export const STATUS_WORDS = Object.freeze({
  current: 'Current', cameBack: 'Came back', notConfirmed: 'Not confirmed', leftDecided: 'Left (decided)', left: 'Left',
});

const isProposed = fact => fact?.status === 'proposed';
const proposedMark = fact => (isProposed(fact) ? ' (proposed)' : '');
const capitalize = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Where a claim comes from, short: "interview with …, date" · "file …, date" · "notes added by …, date". Pure. */
export function sourceText(claim) {
  const kind = claim.sourceKind ?? 'interview';
  if (kind === 'file') return `file ${claim.fileName}, ${claim.interviewedAt}`;
  if (kind === 'text') return `notes added by ${claim.intervieweeName}, ${claim.interviewedAt}`;
  return `interview with ${claim.intervieweeName}, ${claim.interviewedAt}`;
}

// The claim a status rests on, when a claim decides it: coming back, leaving
// without a decision, or being named while the list does not (proposed only
// when every word on them is).
function statusFact(person) {
  if (person.status === 'cameBack') return person.rejoined;
  if (person.status === 'left' && !person.decision) return person.left;
  if (person.status === 'notConfirmed' && person.claims.every(isProposed)) return { status: 'proposed' };
  return null;
}

/** The status cell: the overview's word, "(proposed)" when an unreviewed claim decides it; null without a claim. Pure. */
export function statusText(person) {
  if (person.claims.length === 0 && !person.decision) return null;
  return STATUS_WORDS[person.status] + proposedMark(statusFact(person));
}

/** The role cell: the latest role, and the earlier stint's roles of someone who came back. Pure. */
export function roleText(person) {
  const role = person.role ? `${person.role.value}${proposedMark(person.role)}` : '';
  const earlier = person.status === 'cameBack'
    ? (person.rejoined?.earlier ?? []).map(e => capitalize(e.value)).join(' → ')
    : '';
  const parts = [role, earlier && `earlier: ${earlier}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The claim the source cell names: the role's, else the one about leaving or coming back, else the first. Pure. */
export function basisClaim(person) {
  const id = person.role?.claimId ?? person.left?.claimId ?? person.rejoined?.claimId;
  return person.claims.find(c => c.id === id) ?? person.claims[0] ?? null;
}

/** The three claim cells of a row; all empty for a row nobody said anything about. Pure. */
export function claimCells(person) {
  const basis = person ? basisClaim(person) : null;
  return {
    claimStatus: person ? statusText(person) : null,
    claimRole: person ? roleText(person) : null,
    claimSource: basis ? sourceText(basis) : null,
  };
}

/** The claims grouped per context, then per person (people.js's grouping). Pure. */
export function groupByContext(claimRows, col) {
  const byContext = new Map();
  for (const c of claimRows) {
    if (!byContext.has(c.contextId)) byContext.set(c.contextId, []);
    byContext.get(c.contextId).push(c);
  }
  return new Map([...byContext].map(([id, rows]) => [id, groupClaimsByPerson(rows, col)]));
}

// A person the list does not list, as a member row of the unit report.
function otherRow(unit, person, col) {
  return {
    id: person[col] ?? null, displayName: person.displayName, email: person.email, jobTitle: person.jobTitle,
    department: person.department, principalType: person.principalType, accountEnabled: person.accountEnabled,
    contextId: unit.id, unitName: unit.displayName, extendedAttributes: {}, listed: false, person,
  };
}

/** What the first tab says per unit: { current, former, proposed }. Pure. */
export function unitSummary(unit, members, known, claimRows) {
  const listedHere = members.filter(m => m.contextId === unit.id && !m.markedFormer).length;
  return {
    current: listedHere + known.filter(p => p.status === 'notConfirmed').length,
    former: known.filter(p => FORMER.has(p.status)).length,
    proposed: claimRows.filter(c => c.contextId === unit.id && c.status === 'proposed').length,
  };
}

/**
 * The claims of a run. `units`: the units picked ([{ id, displayName }]); the
 * people the list does not list are read for these only, never for a sub-unit.
 * `members`: the rows read (unitMembers.js), each with its contextId and its
 * decision columns. → { personOf(member), others: [member-shaped rows],
 * summaries: Map(unitId → unitSummary) }.
 */
export async function fetchUnitClaims(kind, units, members, statuses) {
  const col = MEMBER_COLUMN[kind];
  const contextIds = [...new Set([...units.map(u => u.id), ...members.map(m => m.contextId)])];
  const claimRows = await store.personClaimsIn(db, contextIds, kind, statuses);
  const groups = groupByContext(claimRows, col);
  const knownPerUnit = await Promise.all(units.map(async (unit) => {
    const mine = groups.get(unit.id) ?? new Map();
    const holderIds = [...new Set([...mine.values()].map(g => g.holderId).filter(Boolean))];
    const rows = await store.holderRows(db, unit.id, kind, holderIds);
    const holders = new Map(rows.map(h => [holderKey(col, h.id), h]));
    return knownPeople({ groups: mine, holders, roles: [], open: [], col });
  }));

  const others = units.flatMap((unit, i) => {
    const s = splitByStatus(knownPerUnit[i]);
    return [...s.notConfirmed, ...s.left].map(p => otherRow(unit, p, col));
  });
  const summaries = new Map(units.map((unit, i) => [unit.id, unitSummary(unit, members, knownPerUnit[i], claimRows)]));
  const personOf = (member) => {
    if (member.person) return member.person;
    const key = holderKey(col, member.id);
    return buildPerson({ key, member: { ...member, [col]: member.id, listed: true }, group: groups.get(member.contextId)?.get(key) ?? null });
  };
  return { personOf, others, summaries };
}

/** The entries the first tab adds under a unit's people block. Pure. */
export function summaryEntries(summary, { withProposed }) {
  const entries = [
    { label: 'Org claim columns', value: CLAIM_NOTE },
    { label: 'Current members', value: summary.current },
    { label: 'Former people', value: summary.former },
  ];
  // A reader sees confirmed claims only: a count of proposed ones would be a number they cannot check.
  if (withProposed) entries.push({ label: 'Claims proposed (not reviewed)', value: summary.proposed });
  return entries;
}
