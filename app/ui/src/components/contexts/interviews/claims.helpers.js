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
  // What a person does, knows and holds beside their work (the Authorization workbench groups by these).
  activity: 'Activity',
  expertise: 'Expertise',
  duty: 'Duty',
};

// What a membership claim's status means, in the review list.
export const MEMBERSHIP_LABELS = {
  current: 'current member',
  former: 'former member',
  joined: 'joined',
  left: 'left',
  rejoined: 'back again (rejoined)',
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

// What kind of source a claim (or a source row) comes from — the API's
// sourceKind: an interview, a file from nobody in particular, or pasted text.
export const SOURCE_KIND_LABELS = { interview: 'Interview', file: 'File', text: 'Pasted text' };

/** "interview with Anna Voorbeeld, 2026-10-01" · "team.xlsx, 2026-10-01" · "notes added by Ann, 2026-10-01" */
export function sourceLabel(claim) {
  const kind = claim.sourceKind ?? 'interview';
  if (kind === 'file') return `${claim.fileName}, ${claim.interviewedAt}`;
  if (kind === 'text') return `notes added by ${claim.intervieweeName}, ${claim.interviewedAt}`;
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

/** A role claim that would set a role but names nobody we hold: confirming it asks who was meant. Pure. */
export function needsPerson(claim) {
  return claim.claimKind === 'role' && !!claim.roleSuggestion && !claim.principalId && !claim.identityId;
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

const PERSON_CLAIM_KINDS = new Set(['role', 'roleHistory', 'membership', 'activity', 'expertise', 'duty']);

/** A claim about a person (role, history, membership, activity, expertise, duty) rather than about the unit. */
export const isPersonClaim = (c) => PERSON_CLAIM_KINDS.has(c?.claimKind);

/** The confirmed claims about the unit itself, in the groups "What we know" shows. */
export function groupConfirmed(claims) {
  const confirmed = (claims || []).filter(isConfirmed);
  return {
    description: confirmed.filter(c => c.claimKind === 'description'),
    properties: confirmed.filter(c => c.claimKind === 'property'),
    aliases: confirmed.filter(c => c.claimKind === 'alias'),
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

const SNIPPET = 80;
const snippet = (text) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET ? `${s.slice(0, SNIPPET - 1).trimEnd()}…` : s;
};

/**
 * The one line a folded "What we know" shows, about the unit only: the start of
 * its description, then "3 properties · also known as HA · 2 to review" — the
 * review count for a writer only, and only the unit's own claims (a person's are
 * on their row in People). Pure.
 */
export function whatWeKnowSummary({ description, claims, aliases = [], canWrite }) {
  const { properties } = groupConfirmed(claims);
  const parts = [];
  if (description) parts.push(snippet(description));
  if (properties.length) parts.push(plural(properties.length, 'property', 'properties'));
  if (aliases.length) parts.push(`also known as ${aliases.join(', ')}`);
  const toReview = canWrite ? proposedClaims(claims).filter(c => !isPersonClaim(c)).length : 0;
  if (toReview > 0) parts.push(`${toReview} to review`);
  return parts.join(' · ') || 'Nothing recorded yet';
}

export const proposedClaims = (claims) => (claims || []).filter(c => c.status === 'proposed');

/** The folded Sources line: "2 sources · latest 2026-10-23", or that nothing was added. Pure. */
export function sourcesSummary(sources) {
  const list = sources || [];
  if (list.length === 0) return 'Nothing added yet';
  const latest = list.map(s => s.interviewedAt).filter(Boolean).sort().pop();
  return `${plural(list.length, 'source', 'sources')}${latest ? ` · latest ${latest}` : ''}`;
}

// A name as the API's alias merge compares it: case, accents, dots and spacing aside.
const aliasKey = (name) => String(name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[.\s]+/g, '');

/**
 * The context's other names, for its "Also known as" fact: [{ name, status, claim }].
 * Confirmed first — what extendedAttributes.aliases holds (the record; claim null)
 * and confirmed alias claims a re-import may have wiped from it — then, for a
 * writer, the proposed alias claims not yet among them. One entry per name. Pure.
 */
export function aliasFacts(attrs, claims, canWrite) {
  const out = [];
  const seen = new Set();
  const add = (name, status, claim) => {
    const key = aliasKey(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name: String(name), status, claim });
  };
  const stored = attrs?.extendedAttributes?.aliases;
  for (const name of Array.isArray(stored) ? stored : []) if (typeof name === 'string') add(name, 'confirmed', null);
  const aliases = (claims || []).filter(c => c.claimKind === 'alias');
  for (const c of aliases.filter(isConfirmed)) add(c.value, 'confirmed', c);
  if (canWrite) for (const c of aliases.filter(c => c.status === 'proposed')) add(c.value, 'proposed', c);
  return out;
}

/** Proposed role claims that would set `role` — the People block's interview suggestions. */
export function roleSuggestions(claims, role) {
  return proposedClaims(claims).filter(c => c.claimKind === 'role' && c.roleSuggestion === role);
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
export const PERSON_KINDS = new Set(['role', 'roleHistory', 'membership', 'activity', 'expertise', 'duty']);

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

