// Context interviews — what they add to the context's Timeline tab.
//
//   interviewTimelineEvents({ interviews, decisions }) → [event]   (pure)
//   loadInterviewTimeline(db, contextId, opts)         → [event]   (two statements)
//
// The context timeline (routes/recentChanges/timeline.js) reads the context
// row's own _history; an interview changes the context through its claims, so
// these events are read from the interview tables themselves, set-based:
//
//   an interview uploaded       "Interview with Anna Voorbeeld uploaded (gesprek.txt)"
//   its claims extracted        "12 claims extracted from the interview with Anna Voorbeeld"
//   a claim decided             "Confirmed: Membership — Jan Smit (former member)",
//                               "Rejected: Role history — Piet Proef: junior"
//   ...that set a role          "Piet Proef set as Responsible — from the interview with Anna Voorbeeld, 2026-10-01"
//   ...that changed the context "Also known as: Havenkantoor added — from the interview with …",
//                               "sector set to logistics — …", "Description extended — …"
//   ...that decided a contradiction  "Decided: Interview: Jan Smit left · HR export still
//                               lists Jan Smit as a member — the interview is right"
//                               (contradictions.js; a pair reads once, on its last decision)
//
// A reader (no data.write.contexts) gets confirmed decisions only: no uploads,
// no extraction counts, nothing rejected (the route passes the statuses).
// Events have the timeline's shape: { at, operation, eventKind: 'interview', summary,
// counterparty*, detail? } — `detail` is the claim's value where the summary
// leaves it out.

import * as store from './store.js';
import { loadContradictions } from './contradictions.js';

const KIND_WORDS = {
  description: 'Description', property: 'Property', role: 'Role', roleHistory: 'Role history', membership: 'Membership', alias: 'Also known as',
};
const MEMBERSHIP_WORDS = { current: 'current member', former: 'former member', joined: 'joined', left: 'left', rejoined: 'back again (rejoined)' };
const CONFIRMED = new Set(['confirmed', 'edited']);

const event = (at, operation, summary, extra = {}) => ({
  at, operation, eventKind: 'interview', summary, counterpartyKind: null, counterpartyId: null, counterpartyLabel: null, ...extra,
});

const who = (c) => c.subjectDisplayName || c.subjectName || '';
const from = (c) => `from the interview with ${c.intervieweeName}, ${c.interviewedAt}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What a decided claim says, after its kind: "Jan Smit (former member)", "sector: logistics".
function claimWords(c) {
  if (c.claimKind === 'membership') return `${who(c)} (${MEMBERSHIP_WORDS[c.attribute] || c.attribute})`;
  if (c.claimKind === 'property') return `${c.attribute}: ${c.value}`;
  const person = who(c);
  return person ? `${person}: ${c.value}` : c.value;
}

// A confirmed claim that changed the context or set a role reads as that change.
function changeEvent(c) {
  if (c.appliedRole) {
    const name = c.roleHolderName || who(c);
    const link = c.roleHolderId ? { counterpartyKind: c.roleHolderIsAccount ? 'user' : 'identity', counterpartyId: c.roleHolderId, counterpartyLabel: name } : {};
    return event(c.decidedAt, 'added', `${name} set as ${c.appliedRole} — ${from(c)}`, link);
  }
  if (c.claimKind === 'alias') return event(c.decidedAt, 'changed', `Also known as: ${c.value} added — ${from(c)}`);
  if (c.claimKind === 'property') return event(c.decidedAt, 'changed', `${c.attribute} set to ${c.value} — ${from(c)}`);
  if (c.claimKind === 'description') return event(c.decidedAt, 'changed', `Description extended — ${from(c)}`, { detail: c.value });
  return null;
}

function decisionEvent(c) {
  if (CONFIRMED.has(c.status)) {
    const change = changeEvent(c);
    if (change) return change;
    const label = c.status === 'edited' ? 'Confirmed (edited)' : 'Confirmed';
    return event(c.decidedAt, 'changed', `${label}: ${KIND_WORDS[c.claimKind] || c.claimKind} — ${claimWords(c)} — ${from(c)}`);
  }
  return event(c.decidedAt, 'changed', `Rejected: ${KIND_WORDS[c.claimKind] || c.claimKind} — ${claimWords(c)} — ${from(c)}`);
}

/** How a decided contradiction was decided, in words. Pure. */
export function resolutionWords(con) {
  if (con.resolution === 'interview') return 'the interview is right';
  if (con.resolution === 'both') return 'both true, at different times';
  if (con.resolution === 'first') return `kept “${con.claim.statement}”`;
  if (con.resolution === 'second') return `kept “${con.other.statement}”`;
  if (con.resolution === 'neither') return 'neither';
  return 'what we had is right';
}

// claimId → the decided contradiction whose (last) decision that claim's is.
function decidedByClaim(contradictions) {
  const out = new Map();
  for (const con of contradictions) {
    if (con.status !== 'decided') continue;
    for (const id of con.claimIds) out.set(id, con);
  }
  return out;
}

const sameMoment = (a, b) => new Date(a).getTime() === new Date(b).getTime();

/** The timeline events of a context's interviews and claim decisions, newest first. Pure. */
export function interviewTimelineEvents({ interviews = [], decisions = [], contradictions = [] }) {
  const decided = decidedByClaim(contradictions);
  const out = [];
  for (const iv of interviews) {
    out.push(event(iv.createdAt, 'added', `Interview with ${iv.intervieweeName} uploaded (${iv.fileName})`));
    if (iv.extracted > 0 && iv.extractedAt) {
      out.push(event(iv.extractedAt, 'changed', `${plural(iv.extracted, 'claim', 'claims')} extracted from the interview with ${iv.intervieweeName}`));
    }
  }
  for (const c of decisions) {
    const con = decided.get(c.id);
    if (con && (con.claimIds.length === 1 || sameMoment(c.decidedAt, con.decidedAt))) {
      out.push(event(c.decidedAt, 'changed', `Decided: ${con.claim.statement} · ${con.other.statement} — ${resolutionWords(con)}`, { contradictionId: con.id }));
    } else {
      out.push(decisionEvent(c));
    }
  }
  return out.sort((a, b) => new Date(b.at) - new Date(a.at));
}

/**
 * The events, read for the window. `canWrite`: an analyst also gets the uploads,
 * the extraction counts and the rejected claims; a reader confirmed decisions only.
 */
export async function loadInterviewTimeline(db, contextId, { sinceDays, limit, canWrite }) {
  const statuses = canWrite ? ['confirmed', 'edited', 'rejected'] : ['confirmed', 'edited'];
  const rows = await store.timelineRows(db, contextId, { sinceDays, statuses, limit, withInterviews: canWrite });
  let contradictions = [];
  if (rows.decisions.length) {
    const [claims, accountable] = await Promise.all([store.listClaims(db, contextId, statuses), store.currentAccountable(db, contextId)]);
    contradictions = await loadContradictions(db, contextId, claims, accountable);
  }
  return interviewTimelineEvents({ ...rows, contradictions });
}
