// Context interviews — the steps behind the routes (routes/contexts/interviews.js).
//
//   createInterview({ contextId, file, body, user }, deps)  store an added source (a file or pasted text,
//                                                           from someone or not), start extraction
//   retryExtraction(contextId, interviewId, deps)           run extraction again
//   addManualClaim(contextId, interviewId, body, deps)      an analyst's own claim (no model needed)
//   claimsOf(contextId, { statuses }, deps)                 the claims + whether the Accountable is in doubt
//   rejectMany(contextId, body, user, deps)                 reject the proposed claims of a kind / a relevance tier
//   interviewWithTranscript(contextId, interviewId, deps)   one interview, its transcript and where each quote stands
//
// An "interview" here is any source added to the page: an interview, a file, a
// list (csv / xlsx), pasted text (sourceText.js; store.js SOURCE_KIND_SQL).
//
// Every refusal is an InterviewError with the status the route answers and a
// sentence for the analyst. Design: docs/architecture/context-interviews.md.

import * as defaultDb from '../../db/connection.js';
import { ROLE_BEARING_CATEGORIES } from '../../lib/contextCategories.js';
import { detectLanguage } from '../../nlreports/language.js';
import { readSourceText } from './sourceText.js';
import { checkClaim, foldForQuote, ROLE_SUGGESTIONS, CLAIM_KINDS, RELEVANCE } from './claims.js';
import { llmConfigured, startExtraction } from './extract.js';
import { resolveSubjects } from './subjects.js';
import { deduceRoles, accountableDoubt } from './roles.js';
import { loadContradictions } from './contradictions.js';
import { locateQuote } from './quoteOffsets.js';
import * as store from './store.js';
import { KNOWLEDGE_KINDS } from '../../lib/orgKnowledge.js';

export class InterviewError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'InterviewError';
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A run that started this long ago and never finished (the API restarted) may be run again.
// Well past one model answer's default budget (extract.js, 15 minutes): a run whose
// first part waits behind a busy model is not stale.
export const STALE_RUN_MS = 30 * 60 * 1000;

const defaults = (deps = {}) => ({ db: defaultDb, enabled: llmConfigured, start: startExtraction, ...deps });

/** A calendar date that exists, as 'YYYY-MM-DD', or null. Pure. */
export function validDate(value) {
  const s = String(value ?? '').trim();
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * Who the source is from: { col, id } from a form body (principalId or
 * identityId), or null when it names nobody — a file or pasted text need not be
 * an interview. Two at once, or a malformed id, is an InterviewError.
 */
export function parseInterviewee(body = {}) {
  const given = ['principalId', 'identityId'].filter(k => body[k]);
  if (given.length === 0) return null;
  if (given.length !== 1) throw new InterviewError(400, 'Say who it is from: one of principalId or identityId, not both.');
  const id = String(body[given[0]]).toLowerCase();
  if (!UUID_RE.test(id)) throw new InterviewError(400, `${given[0]} must be a uuid`);
  return { col: given[0], id };
}

// The person a source is from, or null; an id that names nobody is refused.
async function sourcePerson(db, who) {
  if (!who) return null;
  const table = who.col === 'principalId' ? 'Principals' : 'Identities';
  const person = await db.queryOne(`SELECT "displayName" FROM "${table}" WHERE id = $1`, [who.id]);
  if (!person) throw new InterviewError(404, who.col === 'principalId' ? 'Principal not found' : 'Identity not found');
  return person;
}

async function roleBearingContext(db, contextId) {
  if (!UUID_RE.test(String(contextId))) throw new InterviewError(400, 'Invalid ID format');
  const ctx = await db.queryOne(`SELECT id, "contextCategory" FROM "Contexts" WHERE id = $1`, [contextId]);
  if (!ctx) throw new InterviewError(404, 'Context not found');
  if (!ROLE_BEARING_CATEGORIES.has(ctx.contextCategory)) {
    throw new InterviewError(400, 'Interviews can be added to an organizational unit or a logical application only.');
  }
  return ctx;
}

export async function createInterview({ contextId, file, body = {}, user }, deps) {
  const { db, enabled, start } = defaults(deps);
  await roleBearingContext(db, contextId);
  const who = parseInterviewee(body);
  const interviewedAt = validDate(body.interviewedAt);
  if (!interviewedAt) throw new InterviewError(400, 'Say when it is from (a date, YYYY-MM-DD).');
  const person = await sourcePerson(db, who);

  const { text, fileName } = await readSourceText({ file, text: body.text });
  const configured = enabled();
  const interview = await store.insertInterview(db, {
    contextId,
    ...(who ? { [who.col]: who.id } : {}),
    // Nobody in particular: the source is the file (or the text) and who added it.
    intervieweeName: who ? person.displayName || who.id : (user || fileName),
    interviewedAt,
    fileName,
    transcript: text,
    language: detectLanguage(text.slice(0, 4000)),
    extractionStatus: configured ? 'pending' : 'notConfigured',
    createdBy: user,
  });
  if (configured) start(interview.id, { db });
  return { ...interview, llmConfigured: configured };
}

/** Run extraction again — refused while a fresh run is still going, or without a model. */
export async function retryExtraction(contextId, interviewId, deps, now = Date.now()) {
  const { db, enabled, start } = defaults(deps);
  const interview = await store.getInterview(db, contextId, interviewId);
  if (!interview) throw new InterviewError(404, 'Interview not found');
  if (!enabled()) throw new InterviewError(503, 'No local model is configured; add claims by hand instead.');
  const started = interview.extractionStartedAt ? new Date(interview.extractionStartedAt).getTime() : 0;
  if (interview.extractionStatus === 'running' && now - started < STALE_RUN_MS) {
    throw new InterviewError(409, 'This interview is being read right now; try again when it is done.');
  }
  await store.setExtraction(db, interviewId, { status: 'pending' });
  start(interviewId, { db });
  return { ...interview, extractionStatus: 'pending' };
}

/**
 * An analyst's claim on an interview: the same check a model's claim passes
 * (claims.js), but the quote is optional. Its person is matched like a model's,
 * unless the body names the holder; a role claim may carry its roleSuggestion.
 */
export async function addManualClaim(contextId, interviewId, body = {}, deps) {
  const { db } = defaults(deps);
  const interview = await store.getInterview(db, contextId, interviewId, { withTranscript: true });
  if (!interview) throw new InterviewError(404, 'Interview not found');
  const checked = checkClaim(body, foldForQuote(interview.transcript), { quoteRequired: false });
  if (checked.error) throw new InterviewError(400, `This claim cannot be added: ${checked.error}.`);
  if (body.roleSuggestion != null && !ROLE_SUGGESTIONS.includes(body.roleSuggestion)) {
    throw new InterviewError(400, `roleSuggestion must be one of ${ROLE_SUGGESTIONS.join(', ')}`);
  }
  let claim = deduceRoles([await withManualSubject(db, contextId, interview, checked.claim)])[0];
  // An analyst chose to add it: it matters.
  const span = claim.quote ? locateQuote(interview.transcript, claim.quote) : null;
  claim = { ...claim, relevance: 'high', quoteStart: span?.start ?? null, quoteEnd: span?.end ?? null };
  if (claim.claimKind === 'role' && body.roleSuggestion !== undefined) claim.roleSuggestion = body.roleSuggestion;
  const [id] = await store.insertClaims(db, { interviewId, contextId, proposedBy: 'analyst' }, [claim]);
  return store.getClaimRow(db, id);
}

// The person an analyst's claim names, matched like a model's; a claim about the context is returned as is.
async function withManualSubject(db, contextId, interview, claim) {
  if (!claim.subjectName) return claim;
  const resolved = await resolveSubjects(db, [claim.subjectName], {
    contextId, interviewee: { principalId: interview.principalId, identityId: interview.identityId, name: interview.intervieweeName },
  });
  const r = resolved.get(claim.subjectName) ?? {};
  return { ...claim, principalId: r.principalId ?? null, identityId: r.identityId ?? null, subjectMatch: r.match ?? null };
}

/**
 * The claims of a context in `statuses`, the claim that doubts its current
 * Accountable (or null — kept for the People block; it is also a 'notOwner'
 * contradiction), and the contradictions among those claims and the context's
 * facts (contradictions.js — a reader's are read from confirmed claims only).
 */
export async function claimsOf(contextId, { statuses }, deps) {
  const { db } = defaults(deps);
  await existingContext(db, contextId);
  const [claims, accountable] = await Promise.all([store.listClaims(db, contextId, statuses, KNOWLEDGE_KINDS), store.currentAccountable(db, contextId)]);
  const doubt = accountableDoubt(claims, accountable);
  const contradictions = await loadContradictions(db, contextId, claims, accountable);
  return {
    data: claims,
    contradictions,
    accountableDoubt: doubt ? { claimId: doubt.id, quote: doubt.quote, intervieweeName: doubt.intervieweeName, interviewedAt: doubt.interviewedAt } : null,
  };
}


async function existingContext(db, contextId) {
  if (!UUID_RE.test(String(contextId))) throw new InterviewError(400, 'Invalid ID format');
  const ctx = await db.queryOne(`SELECT id FROM "Contexts" WHERE id = $1`, [contextId]);
  if (!ctx) throw new InterviewError(404, 'Context not found');
  return ctx;
}

/** The body of POST /contexts/:id/claims/reject → { kind, relevance }, at least one of them. Pure. */
export function parseRejectMany(body = {}) {
  const kind = body.kind ?? null;
  const relevance = body.relevance ?? null;
  if (kind !== null && !CLAIM_KINDS.includes(kind)) throw new InterviewError(400, `kind must be one of ${CLAIM_KINDS.join(', ')}`);
  if (relevance !== null && !RELEVANCE.includes(relevance)) throw new InterviewError(400, `relevance must be one of ${RELEVANCE.join(', ')}`);
  if (kind === null && relevance === null) throw new InterviewError(400, 'Say which claims to reject: a kind, a relevance, or both.');
  return { kind, relevance };
}

/** Reject the context's proposed claims of a kind and/or a relevance tier. { rejected: n, ids }. */
export async function rejectMany(contextId, body, user, deps) {
  const { db } = defaults(deps);
  const filter = parseRejectMany(body);
  await existingContext(db, contextId);
  const ids = await store.rejectProposed(db, contextId, filter, user);
  return { rejected: ids.length, ids };
}

/**
 * One interview with its transcript and `highlights`: [{ claimId, start, end }]
 * for every claim whose quote stands in it — the offsets stored at extraction,
 * else found now (a claim from before offsets were stored). Sorted by start.
 */
export async function interviewWithTranscript(contextId, interviewId, deps) {
  const { db } = defaults(deps);
  const interview = await store.getInterview(db, contextId, interviewId, { withTranscript: true });
  if (!interview) throw new InterviewError(404, 'Interview not found');
  const highlights = [];
  for (const c of await store.interviewQuotes(db, interviewId)) {
    const span = Number.isInteger(c.quoteStart) && Number.isInteger(c.quoteEnd) && c.quoteEnd > c.quoteStart
      ? { start: c.quoteStart, end: c.quoteEnd }
      : locateQuote(interview.transcript, c.quote);
    if (span) highlights.push({ claimId: c.id, start: span.start, end: span.end });
  }
  highlights.sort((a, b) => a.start - b.start || b.end - a.end);
  return { ...interview, highlights };
}
