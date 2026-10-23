// Context interviews — the steps behind the routes (routes/contexts/interviews.js).
//
//   createInterview({ contextId, file, body, user }, deps)  store the transcript, start extraction
//   retryExtraction(contextId, interviewId, deps)           run extraction again
//   addManualClaim(contextId, interviewId, body, deps)      an analyst's own claim (no model needed)
//   claimsOf(contextId, { statuses }, deps)                 the claims + whether the Accountable is in doubt
//
// Every refusal is an InterviewError with the status the route answers and a
// sentence for the analyst. Design: docs/architecture/context-interviews.md.

import * as defaultDb from '../../db/connection.js';
import { ROLE_BEARING_CATEGORIES } from '../../lib/contextCategories.js';
import { detectLanguage } from '../../nlreports/language.js';
import { parseTranscript } from './transcript.js';
import { checkClaim, foldForQuote, ROLE_SUGGESTIONS } from './claims.js';
import { llmConfigured, startExtraction } from './extract.js';
import { resolveSubjects } from './subjects.js';
import { deduceRoles, accountableDoubt } from './roles.js';
import * as store from './store.js';

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
export const STALE_RUN_MS = 15 * 60 * 1000;

const defaults = (deps = {}) => ({ db: defaultDb, enabled: llmConfigured, start: startExtraction, ...deps });

/** A calendar date that exists, as 'YYYY-MM-DD', or null. Pure. */
export function validDate(value) {
  const s = String(value ?? '').trim();
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** { principalId } | { identityId } from a form body, or an InterviewError. */
export function parseInterviewee(body = {}) {
  const given = ['principalId', 'identityId'].filter(k => body[k]);
  if (given.length !== 1) throw new InterviewError(400, 'Say who was interviewed: exactly one of principalId or identityId.');
  const id = String(body[given[0]]).toLowerCase();
  if (!UUID_RE.test(id)) throw new InterviewError(400, `${given[0]} must be a uuid`);
  return { col: given[0], id };
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
  if (!interviewedAt) throw new InterviewError(400, 'Say when the interview took place (a date, YYYY-MM-DD).');
  const table = who.col === 'principalId' ? 'Principals' : 'Identities';
  const person = await db.queryOne(`SELECT "displayName" FROM "${table}" WHERE id = $1`, [who.id]);
  if (!person) throw new InterviewError(404, who.col === 'principalId' ? 'Principal not found' : 'Identity not found');

  const { text } = await parseTranscript(file.buffer, { fileName: file.originalname });
  const configured = enabled();
  const interview = await store.insertInterview(db, {
    contextId,
    [who.col]: who.id,
    intervieweeName: person.displayName || who.id,
    interviewedAt,
    fileName: file.originalname,
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
  let claim = checked.claim;
  if (claim.subjectName) {
    const resolved = await resolveSubjects(db, [claim.subjectName], {
      contextId, interviewee: { principalId: interview.principalId, identityId: interview.identityId, name: interview.intervieweeName },
    });
    const r = resolved.get(claim.subjectName) ?? {};
    claim = { ...claim, principalId: r.principalId ?? null, identityId: r.identityId ?? null, subjectMatch: r.match ?? null };
  }
  claim = deduceRoles([claim])[0];
  if (claim.claimKind === 'role' && body.roleSuggestion !== undefined) claim.roleSuggestion = body.roleSuggestion;
  const [id] = await store.insertClaims(db, { interviewId, contextId, proposedBy: 'analyst' }, [claim]);
  return store.getClaimRow(db, id);
}

/** The claims of a context in `statuses`, and the claim that doubts its current Accountable (or null). */
export async function claimsOf(contextId, { statuses }, deps) {
  const { db } = defaults(deps);
  if (!UUID_RE.test(String(contextId))) throw new InterviewError(400, 'Invalid ID format');
  const ctx = await db.queryOne(`SELECT id FROM "Contexts" WHERE id = $1`, [contextId]);
  if (!ctx) throw new InterviewError(404, 'Context not found');
  const [claims, accountable] = await Promise.all([store.listClaims(db, contextId, statuses), store.currentAccountable(db, contextId)]);
  const doubt = accountableDoubt(claims, accountable);
  return {
    data: claims,
    accountableDoubt: doubt ? { claimId: doubt.id, quote: doubt.quote, intervieweeName: doubt.intervieweeName, interviewedAt: doubt.interviewedAt } : null,
  };
}

