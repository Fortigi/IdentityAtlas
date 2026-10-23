// Context interviews — the pure parts of showing claims.
//
// The API (GET /api/contexts/:id/claims) sends every claim with its source
// (intervieweeName, interviewedAt); these functions only group and word what it
// sent — they derive nothing the data model should hold.

export const CONFIRMED = new Set(['confirmed', 'edited']);

export const KIND_LABELS = {
  description: 'Description',
  property: 'Property',
  role: 'Role',
  roleHistory: 'Role history',
  membership: 'Membership',
  alias: 'Also known as',
};

// What a membership claim's status means, in the review list.
export const MEMBERSHIP_LABELS = {
  current: 'current member',
  former: 'former member',
  joined: 'joined',
  left: 'left',
};

// The statuses that say a person is not in it any more.
export const GONE = new Set(['former', 'left']);

// What a role claim's relation means, in the review list.
export const RELATION_LABELS = {
  owner: 'owner',
  notOwner: 'says they are not the owner',
  dayToDay: 'does the day-to-day',
  delegate: 'backup / delegate',
  member: 'works on it',
  other: 'other',
};

const isConfirmed = (c) => CONFIRMED.has(c.status);

/** "interview with Anna Voorbeeld, 2026-10-01" */
export function sourceLabel(claim) {
  return `interview with ${claim.intervieweeName}, ${claim.interviewedAt}`;
}

/** Who a claim is about: the matched account's name, else the name as spoken. */
export function subjectLabel(claim) {
  return claim.subjectDisplayName || claim.subjectName || '';
}

// Below this the claim may be wrong (the model was unsure, or the sentence check
// in the API found no word for current or gone): the review says so.
export const LOW_CONFIDENCE = 0.4;

/** A claim to read against its quote before confirming. */
export function isLowConfidence(claim) {
  return typeof claim.confidence === 'number' && claim.confidence < LOW_CONFIDENCE;
}

/** A match a person should check before confirming. */
export function isUncertainMatch(claim) {
  return claim.subjectMatch === 'fuzzy' || claim.subjectMatch === 'firstName';
}

const year = (d) => (d ? String(d).slice(0, 4) : null);

/** "Jan Smit — left the account (left)": who, what, and the status or relation in words. Pure. */
export function claimLine(claim) {
  const who = subjectLabel(claim);
  const what = claim.claimKind === 'property' ? `${claim.attribute}: ${claim.value}` : claim.value;
  let how = null;
  if (claim.claimKind === 'role') how = RELATION_LABELS[claim.attribute];
  if (claim.claimKind === 'membership') how = MEMBERSHIP_LABELS[claim.attribute];
  return [who && `${who} —`, what, how && how !== claim.value && `(${how})`].filter(Boolean).join(' ');
}

/** "2015–2017", "since 2021", "until 2019", or the period as said; '' for none. */
export function periodLabel(claim) {
  const from = year(claim.periodFrom);
  const to = year(claim.periodTo);
  let range = '';
  if (from && to) range = from === to ? from : `${from}–${to}`;
  else if (from) range = `since ${from}`;
  else if (to) range = `until ${to}`;
  if (range && claim.periodText) return `${range} (${claim.periodText})`;
  return range || claim.periodText || '';
}

const PERSON_CLAIM_KINDS = new Set(['role', 'roleHistory', 'membership']);

/** The confirmed claims, in the groups the "What we know" section shows. */
export function groupConfirmed(claims) {
  const confirmed = (claims || []).filter(isConfirmed);
  return {
    description: confirmed.filter(c => c.claimKind === 'description'),
    properties: confirmed.filter(c => c.claimKind === 'property'),
    aliases: confirmed.filter(c => c.claimKind === 'alias'),
    people: confirmed.filter(c => PERSON_CLAIM_KINDS.has(c.claimKind)),
  };
}

/** A claim the review folds away: the low tier (a claim without a tier is high). */
export const isLowRelevance = (c) => c.relevance === 'low';

/** Proposed claims split by tier, each in the order given: { high, low }. */
export function byRelevance(claims) {
  const list = claims || [];
  return { high: list.filter(c => !isLowRelevance(c)), low: list.filter(isLowRelevance) };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The one line a folded "What we know" shows: "7 facts · 3 people · 2 proposed
 * to review". Facts are the confirmed claims, people the distinct persons they
 * name; the review count only for a writer, and only when there is one. Pure.
 */
export function whatWeKnowSummary(claims, canWrite) {
  const { description, properties, aliases, people } = groupConfirmed(claims);
  const facts = description.length + properties.length + aliases.length + people.length;
  const persons = new Set(people.map(personKey)).size;
  const parts = [plural(facts, 'fact', 'facts'), plural(persons, 'person', 'people')];
  const toReview = canWrite ? proposedClaims(claims).length : 0;
  if (toReview > 0) parts.push(`${toReview} proposed to review`);
  return parts.join(' · ');
}

export const proposedClaims = (claims) => (claims || []).filter(c => c.status === 'proposed');

/** Proposed role claims that would set `role` — the People block's interview suggestions. */
export function roleSuggestions(claims, role) {
  return proposedClaims(claims).filter(c => c.claimKind === 'role' && c.roleSuggestion === role);
}

const personKey = (c) => c.principalId || c.identityId || `name:${String(c.subjectName || '').toLowerCase()}`;

// A segment's place on the timeline: dated ones by their start, then the
// undated ones in the order the interview gave them.
const sortKey = (c) => c.periodFrom || c.periodTo || '9999';

/**
 * One timeline per person over the confirmed role and role-history claims:
 * [{ key, name, segments: [{ id, label, period, from, to }] }], each person's
 * segments in time order (undated last), people by name.
 */
export function timelines(claims) {
  const byPerson = new Map();
  for (const c of groupConfirmed(claims).people) {
    const key = personKey(c);
    if (!byPerson.has(key)) byPerson.set(key, { key, name: subjectLabel(c), segments: [] });
    byPerson.get(key).segments.push({ id: c.id, label: c.value, period: periodLabel(c), from: c.periodFrom, to: c.periodTo, sort: sortKey(c) });
  }
  return [...byPerson.values()]
    .map(p => ({ ...p, segments: [...p.segments].sort((a, b) => a.sort.localeCompare(b.sort)).map(({ sort: _sort, ...s }) => s) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where each dated segment sits on a shared axis, as percentages: { left, width }
 * from the earliest start to the latest end (today for an open end). Undated
 * segments get null. Pure; `today` is passed in.
 */
export function segmentBars(segments, today) {
  const dated = segments.filter(s => s.from || s.to);
  if (dated.length === 0) return segments.map(() => null);
  const t = (d) => new Date(`${d}T00:00:00Z`).getTime();
  const end = (s) => (s.to ? t(s.to) : today);
  const min = Math.min(...dated.map(s => t(s.from || s.to)));
  const max = Math.max(...dated.map(end));
  const span = Math.max(max - min, 1);
  return segments.map(s => {
    if (!s.from && !s.to) return null;
    const left = ((t(s.from || s.to) - min) / span) * 100;
    const width = Math.max(((end(s) - t(s.from || s.to)) / span) * 100, 2);
    return { left: Math.round(left * 10) / 10, width: Math.round(Math.min(width, 100 - left) * 10) / 10 };
  });
}

export const EXTRACTION_LABELS = {
  pending: 'Waiting for the model…',
  running: 'Reading…',
  done: 'Read',
  failed: 'Reading failed',
  notConfigured: 'No model configured — add claims by hand',
};

// The model answers one request at a time: past this, a run may be queued behind
// another (a report, a cache warm-up) rather than slow. The API cannot tell which.
export const BUSY_AFTER_MS = 2 * 60_000;

/** The status line of an interview; a long run says how long, and why it may wait. Pure; `now` is passed in. */
export function extractionLabel(iv, now) {
  const label = EXTRACTION_LABELS[iv.extractionStatus] || iv.extractionStatus;
  const started = iv.extractionStartedAt ? new Date(iv.extractionStartedAt).getTime() : Number.NaN;
  if (iv.extractionStatus !== 'running' || !(now - started >= BUSY_AFTER_MS)) return label;
  const minutes = Math.floor((now - started) / 60_000);
  return `Reading… ${minutes} min — the model may still be busy with another request`;
}

/** True while any interview is still being read (the list then refreshes itself). */
export function anyInProgress(interviews) {
  return (interviews || []).some(i => i.extractionStatus === 'pending' || i.extractionStatus === 'running');
}

// ─── The manual "Add claim" form ─────────────────────────────────────────
export const PERSON_KINDS = new Set(['role', 'roleHistory', 'membership']);

/** The body POSTed for the form's fields: only what the kind uses. Pure. */
export function manualClaimBody(form) {
  const body = { kind: form.kind, value: form.value.trim() };
  if (PERSON_KINDS.has(form.kind)) body.subject = form.subject.trim();
  if (form.kind === 'role') body.relation = form.relation;
  if (form.kind === 'membership') body.membership = form.membership;
  if (form.kind === 'property') body.attribute = form.attribute.trim();
  if (form.periodText.trim()) body.periodText = form.periodText.trim();
  if (form.quote.trim()) body.quote = form.quote.trim();
  return body;
}

/** Whether the form can be sent: a value, and the person or attribute its kind needs. Pure. */
export function manualClaimReady(form) {
  if (!form.value.trim()) return false;
  if (PERSON_KINDS.has(form.kind)) return !!form.subject.trim();
  if (form.kind === 'property') return !!form.attribute.trim();
  return true;
}

