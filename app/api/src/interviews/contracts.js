// Identity Atlas Interviews — the closed vocabularies and the request validators.
//
// Every value the interview store persists in a CHECK-constrained column is listed
// here once; migration 084_interviews.sql repeats the same lists in its CHECKs and
// 084_interviews.test.js fails when the two drift apart.
//
// Validators return `{ ok: true, value }` or `{ ok: false, error }` with a sentence
// error — the same shape the org-truth contracts use, so the two can merge later.
// See docs/architecture/interviews.md.

export const INTERVIEW_TYPES = Object.freeze(['role-mining', 'data-owner']);

// What the server may keep of the spoken content. Audio is never accepted at all;
// a full transcript is not offered in this slice (it needs a dedicated policy).
//   local-only        — hashes, offsets and timestamps only; no words on the server
//   evidence-excerpt  — plus the short excerpt behind each statement
export const STORAGE_POLICIES = Object.freeze(['local-only', 'evidence-excerpt']);

export const ENTITY_KINDS = Object.freeze(['identity', 'account', 'resource', 'context']);

// The resolution states from the handover, verbatim.
export const RESOLUTION_STATES = Object.freeze(['unresolved', 'suggested', 'confirmed', 'rejected', 'not_found', 'deferred']);

export const PROPOSAL_KINDS = Object.freeze(['relationship', 'role', 'responsibility', 'new-entity']);

export const REVIEW_ACTIONS = Object.freeze(['approve', 'reject', 'defer']);

export const MAX_BATCH = 100;
export const MAX_TEXT = 200;
export const MAX_EXCERPT = 1000;
export const MAX_RATIONALE = 1000;
export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 3650;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[A-Za-z0-9._:/@+-]{1,100}$/;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const isHash = (v) => typeof v === 'string' && HASH_RE.test(v);

const ok = (value) => ({ ok: true, value });
const bad = (error) => ({ ok: false, error });

/** A trimmed string of 1..max characters, or null when absent/empty. Throws nothing. */
export function text(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

const optionalText = (v, max) => (v === undefined || v === null || v === '' ? { ok: true, value: null } : (text(v, max) ? ok(text(v, max)) : bad(`must be at most ${max} characters`)));

const nonNegativeInt = (v) => Number.isInteger(v) && v >= 0;

/** A time range in milliseconds from the start of the recording. */
export function checkTimeRange(startMs, endMs) {
  if (!nonNegativeInt(startMs) || !nonNegativeInt(endMs)) return 'startMs and endMs must be whole milliseconds, 0 or more';
  if (endMs < startMs) return 'endMs must not be before startMs';
  return null;
}

/** Character offsets into the segment text, end exclusive. */
export function checkSpan(spanStart, spanEnd) {
  if (!nonNegativeInt(spanStart) || !nonNegativeInt(spanEnd)) return 'spanStart and spanEnd must be whole numbers, 0 or more';
  if (spanEnd <= spanStart) return 'spanEnd must be after spanStart';
  return null;
}

/** POST /v1/interviews */
export function validateNewInterview(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!INTERVIEW_TYPES.includes(b.interviewType)) return bad(`interviewType must be one of: ${INTERVIEW_TYPES.join(', ')}`);
  // No hidden recording: the client states the notice was shown and confirmed, and which text.
  if (b.noticeConfirmed !== true) return bad('The recording notice must be confirmed before an interview is created');
  const noticeVersion = text(b.noticeVersion, 100);
  if (!noticeVersion) return bad('noticeVersion is required (the notice text the participant was shown)');
  const policy = b.storagePolicy ?? 'local-only';
  if (!STORAGE_POLICIES.includes(policy)) return bad(`storagePolicy must be one of: ${STORAGE_POLICIES.join(', ')}`);
  const days = b.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) return bad(`retentionDays must be a whole number from 1 to ${MAX_RETENTION_DAYS}`);
  for (const key of ['subjectIdentityId', 'scopeContextId']) {
    if (b[key] !== undefined && b[key] !== null && !isUuid(b[key])) return bad(`${key} must be a UUID`);
  }
  const title = optionalText(b.title, MAX_TEXT);
  if (!title.ok) return bad(`title ${title.error}`);
  return ok({
    interviewType: b.interviewType,
    title: title.value,
    noticeVersion,
    storagePolicy: policy,
    retentionDays: days,
    subjectIdentityId: b.subjectIdentityId ?? null,
    scopeContextId: b.scopeContextId ?? null,
  });
}

/** One mention in POST /v1/interviews/:id/mentions */
export function validateMention(m) {
  if (!m || typeof m !== 'object') return bad('each mention must be an object');
  const literal = text(m.literalText, MAX_TEXT);
  if (!literal) return bad(`literalText is required (at most ${MAX_TEXT} characters)`);
  const range = checkTimeRange(m.startMs, m.endMs);
  if (range) return bad(range);
  const span = checkSpan(m.spanStart, m.spanEnd);
  if (span) return bad(span);
  if (m.entityKindHint !== undefined && m.entityKindHint !== null && !ENTITY_KINDS.includes(m.entityKindHint)) {
    return bad(`entityKindHint must be one of: ${ENTITY_KINDS.join(', ')}`);
  }
  const segmentId = text(m.segmentId, 100);
  if (!segmentId) return bad('segmentId is required (the client\'s transcript segment id)');
  if (m.detector !== undefined && !VERSION_RE.test(String(m.detector))) return bad('detector must name the detector and its version, e.g. "lexicon@1"');
  return ok({
    segmentId,
    literalText: literal,
    startMs: m.startMs,
    endMs: m.endMs,
    spanStart: m.spanStart,
    spanEnd: m.spanEnd,
    entityKindHint: m.entityKindHint ?? null,
    detector: m.detector ?? 'unspecified',
  });
}

/** Validates a non-empty array of at most MAX_BATCH items with `one`. */
export function validateBatch(items, one, name) {
  if (!Array.isArray(items) || items.length === 0) return bad(`${name} must be a non-empty array`);
  if (items.length > MAX_BATCH) return bad(`${name} may hold at most ${MAX_BATCH} items`);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const r = one(items[i]);
    if (!r.ok) return bad(`${name}[${i}]: ${r.error}`);
    out.push(r.value);
  }
  return ok(out);
}

/** One evidence span behind a statement. The excerpt text itself is optional. */
export function validateEvidence(e) {
  if (!e || typeof e !== 'object') return bad('each evidence item must be an object');
  const segmentId = text(e.segmentId, 100);
  if (!segmentId) return bad('segmentId is required');
  const range = checkTimeRange(e.startMs, e.endMs);
  if (range) return bad(range);
  const span = checkSpan(e.spanStart, e.spanEnd);
  if (span) return bad(span);
  if (!isHash(e.excerptHash)) return bad('excerptHash must be the lowercase hex SHA-256 of the excerpt');
  const excerpt = optionalText(e.excerpt, MAX_EXCERPT);
  if (!excerpt.ok) return bad(`excerpt ${excerpt.error}`);
  const stt = text(e.sttEngine, 100) ?? 'unspecified';
  return ok({ segmentId, startMs: e.startMs, endMs: e.endMs, spanStart: e.spanStart, spanEnd: e.spanEnd, excerptHash: e.excerptHash, excerpt: excerpt.value, sttEngine: stt });
}

function checkEntityRef(entityId, entityKind) {
  if (entityId !== null && !isUuid(entityId)) return 'entityId must be a UUID';
  if ((entityId === null) !== (entityKind === null)) return 'entityId and entityKind go together';
  if (entityKind !== null && !ENTITY_KINDS.includes(entityKind)) return `entityKind must be one of: ${ENTITY_KINDS.join(', ')}`;
  return null;
}

function checkMatchFields(score, count) {
  if (score !== null && !(typeof score === 'number' && score >= 0 && score <= 1)) return 'matchScore must be between 0 and 1';
  if (count !== null && !(Number.isInteger(count) && count >= 0)) return 'candidateCount must be a whole number, 0 or more';
  return null;
}

/**
 * POST /v1/interviews/:id/mentions/:mentionId/resolutions — the shape only. Whether the
 * move is allowed from the mention's current state is resolution.js's checkTransition.
 */
export function validateResolution(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!RESOLUTION_STATES.includes(b.state)) return bad(`state must be one of: ${RESOLUTION_STATES.join(', ')}`);
  const origin = b.origin ?? 'analyst';
  if (origin !== 'analyst' && origin !== 'detector') return bad('origin must be "analyst" or "detector"');
  const entityId = b.entityId ?? null;
  const entityKind = b.entityKind ?? null;
  const matchScore = b.matchScore ?? null;
  const candidateCount = b.candidateCount ?? null;
  const refused = checkEntityRef(entityId, entityKind) ?? checkMatchFields(matchScore, candidateCount);
  if (refused) return bad(refused);
  const rationale = optionalText(b.rationale, MAX_RATIONALE);
  if (!rationale.ok) return bad(`rationale ${rationale.error}`);
  return ok({ state: b.state, origin, entityKind, entityId, matchScore, candidateCount, rationale: rationale.value });
}

/** A side of a claim: a resolved mention, or an unresolved literal. Never a bare entity id. */
export function validateClaimRef(r) {
  if (!r || typeof r !== 'object') return bad('must be an object');
  if (r.mentionId !== undefined) return isUuid(r.mentionId) ? ok({ mentionId: r.mentionId }) : bad('mentionId must be a UUID');
  const literal = text(r.literal, MAX_TEXT);
  return literal ? ok({ literal }) : bad('give a mentionId or a literal');
}

function validateClaimBody(b) {
  const subject = validateClaimRef(b.subject);
  if (!subject.ok) return bad(`subject ${subject.error}`);
  const object = validateClaimRef(b.object);
  if (!object.ok) return bad(`object ${object.error}`);
  const predicate = text(b.predicate, 100);
  if (!predicate) return bad('predicate is required (at most 100 characters)');
  const c = b.claimConfidence;
  if (c !== undefined && c !== null && !(typeof c === 'number' && c >= 0 && c <= 1)) return bad('claimConfidence must be between 0 and 1');
  const extractor = b.extractor ?? 'analyst';
  if (!VERSION_RE.test(String(extractor))) return bad('extractor must name the engine and its version, e.g. "rules@1"');
  const attribution = optionalText(b.attribution, MAX_TEXT);
  if (!attribution.ok) return bad(`attribution ${attribution.error}`);
  const evidence = validateBatch(b.evidence, validateEvidence, 'evidence');
  if (!evidence.ok) return evidence;
  return ok({ subject: subject.value, object: object.value, predicate, claimConfidence: c ?? null, extractor, attribution: attribution.value, evidence: evidence.value });
}

/** POST /v1/interviews/:id/statements — and a revision of one. */
export function validateStatement(body) {
  return validateClaimBody(body && typeof body === 'object' ? body : {});
}

/** POST /v1/interviews/:id/proposals */
export function validateProposal(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!PROPOSAL_KINDS.includes(b.proposalKind)) return bad(`proposalKind must be one of: ${PROPOSAL_KINDS.join(', ')}`);
  if (!isUuid(b.statementId)) return bad('statementId must be a UUID');
  const summary = text(b.summary, MAX_TEXT);
  if (!summary) return bad(`summary is required (at most ${MAX_TEXT} characters)`);
  return ok({ proposalKind: b.proposalKind, statementId: b.statementId, summary });
}

/** POST /v1/interviews/:id/proposals/:proposalId/reviews */
export function validateReview(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!REVIEW_ACTIONS.includes(b.action)) return bad(`action must be one of: ${REVIEW_ACTIONS.join(', ')}`);
  if (!Number.isInteger(b.targetVersion) || b.targetVersion < 1) return bad('targetVersion must be the statement version you reviewed');
  const rationale = optionalText(b.rationale, MAX_RATIONALE);
  if (!rationale.ok) return bad(`rationale ${rationale.error}`);
  if (b.action === 'reject' && !rationale.value) return bad('A rejection needs a rationale');
  return ok({ action: b.action, targetVersion: b.targetVersion, rationale: rationale.value });
}
