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
};

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

/** A match a person should check before confirming. */
export function isUncertainMatch(claim) {
  return claim.subjectMatch === 'fuzzy' || claim.subjectMatch === 'firstName';
}

const year = (d) => (d ? String(d).slice(0, 4) : null);

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

/** The confirmed claims, in the three groups the "What we know" section shows. */
export function groupConfirmed(claims) {
  const confirmed = (claims || []).filter(isConfirmed);
  return {
    description: confirmed.filter(c => c.claimKind === 'description'),
    properties: confirmed.filter(c => c.claimKind === 'property'),
    people: confirmed.filter(c => c.claimKind === 'role' || c.claimKind === 'roleHistory'),
  };
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
  pending: 'Waiting to be read',
  running: 'Being read…',
  done: 'Read',
  failed: 'Reading failed',
  notConfigured: 'No model configured — add claims by hand',
};

/** True while any interview is still being read (the list then refreshes itself). */
export function anyInProgress(interviews) {
  return (interviews || []).some(i => i.extractionStatus === 'pending' || i.extractionStatus === 'running');
}

// ─── The manual "Add claim" form ─────────────────────────────────────────
export const PERSON_KINDS = new Set(['role', 'roleHistory']);

/** The body POSTed for the form's fields: only what the kind uses. Pure. */
export function manualClaimBody(form) {
  const body = { kind: form.kind, value: form.value.trim() };
  if (PERSON_KINDS.has(form.kind)) body.subject = form.subject.trim();
  if (form.kind === 'role') body.relation = form.relation;
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

