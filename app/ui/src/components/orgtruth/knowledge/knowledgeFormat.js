// Org Info → Knowledge: pure helpers (no React) for the transcript screens.
//
// Kept apart from the .jsx files so the logic is unit-tested on its own and the
// components stay presentational. Shapes are those of /api/org-truth/knowledge
// (docs/architecture/org-knowledge-extraction.md).

// Path prefix under /api/org-truth (wizardApi's API) for every knowledge route.
export const KNOWLEDGE = '/knowledge';

// The closed predicate list of the API (contracts.js PREDICATES), with the words
// a reviewer reads. The API refuses any predicate not in this list.
export const PREDICATE_LABELS = Object.freeze({
  memberOf: 'member of',
  formerMemberOf: 'former member of',
  partOf: 'part of',
  leads: 'leads',
  responsibleFor: 'responsible for',
  worksForCustomer: 'works for customer',
  usesApplication: 'uses application',
  hasProperty: 'has property',
  other: 'other',
});
export const PREDICATES = Object.freeze(Object.keys(PREDICATE_LABELS));

export function predicateLabel(predicate) {
  return PREDICATE_LABELS[predicate] ?? predicate ?? '';
}

export const SOURCE_TYPES = Object.freeze(['interview', 'meeting', 'note', 'other']);
export const CLASSIFICATIONS = Object.freeze(['internal', 'confidential', 'restricted']);
export const ACCEPTED_FILES = '.txt,.md,.srt,.vtt';

// Pill colour family (orgFormat pillColorClass) per modality and support value.
const MODALITY_COLOR = { stated: 'green', implied: 'blue', uncertain: 'amber', correction: 'red', question: 'gray' };
const SUPPORT_COLOR = { supported: 'green', unclear: 'amber', unsupported: 'red' };
export const modalityColor = (modality) => MODALITY_COLOR[modality] ?? 'gray';
export const supportColor = (support) => SUPPORT_COLOR[support] ?? 'gray';

export const isRunActive = (run) => run?.status === 'queued' || run?.status === 'running';

// "3/10" of a run's details.progress, '' when it has none.
export function progressCount(run) {
  const p = run?.details?.progress;
  if (!p || !Number.isFinite(p.total) || p.total <= 0) return '';
  return `${p.done ?? 0}/${p.total}`;
}

// Whole seconds between a run's createdAt and its finishedAt (or `now`), null without a start.
export function elapsedSeconds(run, now = Date.now()) {
  const start = Date.parse(run?.createdAt ?? '');
  if (Number.isNaN(start)) return null;
  const end = run?.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, Math.round((end - start) / 1000));
}

// One line on what a run wrote, or its error; '' before it has stats.
export function runResult(run) {
  if (run?.error) return run.error;
  const w = run?.stats?.written;
  if (!w) return '';
  return `${w.claims ?? 0} statements · ${w.mentions ?? 0} mentions · ${w.findings ?? 0} findings`;
}

// The passage an evidence quote sits in: by seq first, else the one whose span holds it.
export function passageFor(passages, evidence) {
  const list = passages ?? [];
  const bySeq = evidence?.seq != null ? list.find(p => p.seq === evidence.seq) : null;
  if (bySeq) return bySeq;
  return list.find(p => p.startChar <= evidence?.startChar && evidence?.endChar <= p.endChar) ?? null;
}

// The passage text split around the quote [startChar, endChar) — offsets are
// absolute into the source text, so they shift by the passage's own start.
// Null when the span does not fall inside the passage.
export function splitHighlight(passage, startChar, endChar) {
  if (!passage || typeof passage.text !== 'string') return null;
  const from = startChar - passage.startChar;
  const to = endChar - passage.startChar;
  if (!(from >= 0 && to > from && to <= passage.text.length)) return null;
  return { before: passage.text.slice(0, from), mark: passage.text.slice(from, to), after: passage.text.slice(to) };
}

// Statements grouped by topic, in first-seen order; a missing topic is "other".
export function groupByTopic(claims) {
  const groups = new Map();
  for (const c of claims ?? []) {
    const topic = c.topic || 'other';
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(c);
  }
  return [...groups].map(([topic, items]) => ({ topic, claims: items }));
}

// Who is meant by a mention, in one word: the open question a reviewer answers.
const RESOLUTION_TEXT = {
  candidates: 'possible matches',
  ambiguous: 'ambiguous — several objects fit',
  unmatched: 'no match found',
};
export function resolutionText(resolution) {
  return RESOLUTION_TEXT[resolution] ?? resolution ?? '';
}

// "why matched": the signals plus the value they matched on.
export function matchReasons(candidate) {
  const reasons = (candidate?.reasons ?? []).filter(Boolean);
  const value = candidate?.matchedValue ? `matched “${candidate.matchedValue}”` : '';
  return [...reasons, value].filter(Boolean).join(' · ');
}

// The form fields of "Add transcript" → the request: a FormData when a file is
// chosen, a JSON body when text was pasted. Empty fields are left out.
const FIELD_KEYS = ['displayName', 'observedAt', 'speaker', 'language', 'sourceType', 'classification', 'note'];
export function transcriptRequest(form, file) {
  const fields = Object.fromEntries(FIELD_KEYS.filter(k => form[k]).map(k => [k, form[k]]));
  if (file) {
    const data = new FormData();
    data.append('file', file);
    for (const [k, v] of Object.entries(fields)) data.append(k, v);
    return { kind: 'form', data };
  }
  return { kind: 'json', data: { ...fields, text: form.text ?? '' } };
}

// The closed mention type list of the API (contracts.js MENTION_TYPES).
export const MENTION_TYPES = Object.freeze(['person', 'team', 'organisation', 'customer', 'application', 'location', 'role', 'concept']);

// Confidence bands of a statement, in display order. The API sends `band`;
// without it the same thresholds are applied to `confidence`, and a statement
// with neither has not been scored yet.
export const BANDS = Object.freeze([
  { key: 'high', title: 'High confidence', hint: '≥ 80', color: 'green' },
  { key: 'medium', title: 'Medium confidence', hint: '50–79', color: 'amber' },
  { key: 'low', title: 'Low confidence', hint: '< 50', color: 'red' },
  { key: 'unscored', title: 'Not scored', hint: '', color: 'gray' },
]);
const BAND_BY_KEY = Object.fromEntries(BANDS.map(b => [b.key, b]));

export function bandOf(claim) {
  if (BAND_BY_KEY[claim?.band]) return claim.band;
  const c = claim?.confidence;
  if (typeof c !== 'number' || !Number.isFinite(c)) return 'unscored';
  if (c >= 80) return 'high';
  return c >= 50 ? 'medium' : 'low';
}

export const bandColor = (band) => BAND_BY_KEY[band]?.color ?? 'gray';

// Statements grouped by band (High, Medium, Low, Not scored), empty bands left
// out. Each group carries the words a bulk confirmation uses (`scope`).
export function groupByBand(claims) {
  const list = claims ?? [];
  return BANDS
    .map(b => ({ key: b.key, title: b.title, hint: b.hint, scope: b.title, claims: list.filter(c => bandOf(c) === b.key) }))
    .filter(g => g.claims.length > 0);
}

// The same group shape for "Group by: Topic".
export function topicGroups(claims) {
  return groupByTopic(claims).map(g => ({ key: g.topic, title: g.topic, hint: '', scope: `topic “${g.topic}”`, claims: g.claims }));
}

// Ids of the statements a bulk decision may change: only the proposed ones.
export const proposedIds = (claims) => (claims ?? []).filter(c => c.status === 'proposed').map(c => c.id);

// The confirmation of a bulk Accept/Reject over `count` statements in `scope`
// (a group title, or null for everything shown).
export function bulkMessage(status, count, scope) {
  const verb = status === 'accepted' ? 'Accept' : 'Reject';
  const noun = count === 1 ? 'statement' : 'statements';
  const where = scope ? `the ${count} ${noun} in ${scope}` : `the ${count} shown ${noun}`;
  return `${verb} ${where}? Statements already decided are not changed.`;
}

// "transcript 60 · matching 10 · data 30", '' without parts.
const PART_KEYS = ['transcript', 'matching', 'data'];
export function confidencePartsText(parts) {
  if (!parts) return '';
  return PART_KEYS.filter(k => parts[k] != null).map(k => `${k} ${parts[k]}`).join(' · ');
}

// The corroboration pill: colour and words, null when the data said nothing.
const VERDICTS = {
  corroborated: { color: 'green', text: 'confirmed by data' },
  contradicted: { color: 'red', text: 'contradicted by data' },
};
export function corroborationPill(corroboration) {
  const v = VERDICTS[corroboration?.verdict];
  return v ? { ...v, detail: corroboration.detail ?? '' } : null;
}

// The transcript's own spelling when a reviewer renamed the mention, else null.
export function renamedFrom(item) {
  const original = item?.originalLabel;
  return original && original !== item.label ? original : null;
}

// The rename form → PUT /knowledge/mentions/:id body.
export const mentionEditBody = (form) => ({ label: (form.label ?? '').trim(), type: form.type });

// One line on a rescore answer.
export function rescoreText(result) {
  const r = result ?? {};
  return `Scored ${r.scored ?? 0} statements: ${r.corroborated ?? 0} confirmed by data, ${r.contradicted ?? 0} contradicted.`;
}
