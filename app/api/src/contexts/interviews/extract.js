// Context interviews — turn a transcript into proposed claims with the local model.
//
//   extractInterview(interviewId, deps) → Promise<{ status, claims, message }>
//   startExtraction(interviewId, deps)  → runs it in the background (never throws)
//
// The model is the report generator's (nlreports/llm.js), configured by
// NL_REPORTS_LLM_URL — the one the list upload's refinement uses (upload/aiRefine.js).
// Without it the interview is stored with status 'notConfigured' and the analyst
// adds claims by hand: never a dead end.
//
// With it, per part of the transcript (PART_CHARS, at most MAX_PARTS — a longer
// transcript says how much was read, never silently less):
//   1. ask for claims (prompt.js), with a time budget; a reply that is not JSON or
//      has no claims list gets ONE repair round (the org-truth proposal's pattern);
//   2. check every claim (claims.js) — a quote that is not verbatim drops the claim;
//      what a small model left out is filled where that needs no guess (repairClaim),
//      and every drop is logged with the field it failed on. No second model round
//      asks for the missing fields: one costs as much as the part itself;
//   3. across parts: drop repeats, and anything already decided in an earlier run;
//   4. match the people named (subjects.js — with the quote's full name and a unique
//      surname as fallbacks), set role suggestions (roles.js), the relevance tier
//      (relevance.js) and where each quote stands in the transcript (quoteOffsets.js);
//      an alias that is the context's own name is no alias and is dropped;
//   5. replace the interview's undecided model claims with these, in one transaction.
// Status: running → done (with a note on what was dropped) or failed (with why).
// Nothing is written to the context: every claim waits for review.

import * as defaultDb from '../../db/connection.js';
import { chat } from '../../nlreports/llm.js';
import { getReportModel } from '../../nlreports/settings.js';
import { withTimeout } from '../upload/aiRefine.js';
import { checkClaim, foldForQuote } from './claims.js';
import { buildSystemPrompt, buildUserMessage, RESPONSE_SCHEMA, MAX_CLAIMS_PER_PART } from './prompt.js';
import { resolveClaimSubjects } from './subjects.js';
import { deduceRoles } from './roles.js';
import { withRelevance } from './relevance.js';
import { withQuoteOffsets } from './quoteOffsets.js';
import { normalizeName } from '../../lib/nameMatch.js';
import * as store from './store.js';

export const PART_CHARS = 10_000;
export const MAX_PARTS = 40;
// One model answer may take this long. Extraction runs in the background, so it
// gets the report model's budget: on a small box one part takes minutes, and the
// model's single slot may first finish another request (a report, a cache warm-up).
export const DEFAULT_TIMEOUT_MS = 900_000;

/** INTERVIEW_LLM_TIMEOUT_MS, else NL_REPORTS_LLM_TIMEOUT_MS, else DEFAULT_TIMEOUT_MS. */
export function chatTimeoutMs(env = process.env) {
  for (const v of [env.INTERVIEW_LLM_TIMEOUT_MS, env.NL_REPORTS_LLM_TIMEOUT_MS]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}
export const MAX_REPLY_TOKENS = 2000;

export const llmConfigured = () => !!process.env.NL_REPORTS_LLM_URL;

/** Cut a transcript into parts of at most `size` characters, on line breaks where it can. Pure. */
export function splitTranscript(text, size = PART_CHARS) {
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > size) {
      if (current) { parts.push(current); current = ''; }
      parts.push(rest.slice(0, size));
      rest = rest.slice(size);
    }
    const next = current ? `${current}\n${rest}` : rest;
    if (next.length > size) { parts.push(current); current = rest; } else current = next;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Check a parsed reply. { ok: true, claims, dropped: { invalid, quote, fields }, repaired }
 * when it is a claims list (bad claims dropped and counted, by the field they
 * failed on), else { ok: false, error }.
 */
export function checkReply(reply, folded) {
  if (!reply || typeof reply !== 'object' || !Array.isArray(reply.claims)) {
    return { ok: false, error: 'The reply must be one JSON object with a "claims" list.' };
  }
  const dropped = emptyDropped();
  const claims = [];
  let repaired = 0;
  for (const raw of reply.claims.slice(0, MAX_CLAIMS_PER_PART)) {
    const checked = checkClaim(raw, folded, { repair: true });
    if (checked.claim) {
      claims.push(checked.claim);
      if (checked.repaired) repaired++;
    } else {
      dropped[checked.reason]++;
      dropped.fields[checked.field] = (dropped.fields[checked.field] ?? 0) + 1;
      console.info(`Context interview: a claim was left out (${checked.field}): ${checked.error}`);
    }
  }
  return { ok: true, claims, dropped, repaired };
}

export const emptyDropped = () => ({ invalid: 0, quote: 0, fields: {} });

const parse = (content) => { try { return JSON.parse(content); } catch { return null; } };

export async function defaultAsk(messages) {
  const model = await getReportModel().catch(() => undefined);
  const { content } = await chat({ model, messages, schema: RESPONSE_SCHEMA, maxTokens: MAX_REPLY_TOKENS });
  return { content, model: model ?? null };
}

/** One part: ask, and once more with the error when the reply is unusable. */
export async function askPart(messages, folded, { ask = defaultAsk, timeoutMs = chatTimeoutMs() } = {}) {
  const first = await withTimeout(ask(messages), timeoutMs);
  const firstCheck = checkReply(parse(first.content), folded);
  if (firstCheck.ok) return { ...firstCheck, model: first.model };
  const retry = [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: `${firstCheck.error} Reply again with the whole JSON.` }];
  const second = await withTimeout(ask(retry), timeoutMs);
  const secondCheck = checkReply(parse(second.content), folded);
  if (secondCheck.ok) return { ...secondCheck, model: second.model };
  throw new Error(`the model's answer could not be read twice (${secondCheck.error})`);
}

const claimKey = (c) => [c.claimKind, String(c.subjectName ?? '').toLowerCase(), c.attribute ?? '', foldForQuote(c.value).toLowerCase()].join('|');

/** Drop repeats, and claims equal to `kept` (decided ones, an analyst's). Pure. */
export function dedupeClaims(claims, kept = []) {
  const seen = new Set(kept.map(claimKey));
  return claims.filter(c => {
    const k = claimKey(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Drop an "alias" that is only the context's own name. Pure. */
export function dropOwnNameAliases(claims, contextName) {
  const own = normalizeName(contextName);
  return claims.filter(c => c.claimKind !== 'alias' || normalizeName(c.value) !== own);
}

/** Holder + match for every claim about a person (and the full name, when the quote gave it). */
async function withSubjects(db, claims, interview) {
  const resolved = await resolveClaimSubjects(db, claims, {
    contextId: interview.contextId,
    interviewee: { principalId: interview.principalId, identityId: interview.identityId, name: interview.intervieweeName },
  });
  return claims.map((c, i) => {
    const r = resolved[i];
    return { ...c, subjectName: r.subjectName, principalId: r.principalId ?? null, identityId: r.identityId ?? null, subjectMatch: r.match ?? null };
  });
}

const FIELD_WORDS = { membership: 'without a membership status', subject: 'without the person', value: 'without a value', kind: 'of an unknown kind', claim: 'that were not a claim', attribute: 'without an attribute name' };

/** The sentence stored with a finished run: what was read and what was left out. Pure. */
export function runMessage({ partsRead, partsTotal, dropped, repaired = 0 }) {
  const notes = [];
  if (partsRead < partsTotal) notes.push(`Only the first ${partsRead} of ${partsTotal} parts of the transcript were read.`);
  if (dropped.quote) notes.push(`${dropped.quote} claim${dropped.quote === 1 ? ' was' : 's were'} left out because the quote is not in the transcript.`);
  if (dropped.invalid) {
    const why = Object.entries(dropped.fields ?? {}).filter(([f]) => f !== 'quote').map(([f, n]) => `${n} ${FIELD_WORDS[f] ?? f}`);
    notes.push(`${dropped.invalid} incomplete claim${dropped.invalid === 1 ? ' was' : 's were'} left out${why.length ? ` (${why.join(', ')})` : ''}.`);
  }
  if (repaired) notes.push(`${repaired} claim${repaired === 1 ? ' had a field' : 's had fields'} filled in from the quote — check ${repaired === 1 ? 'it' : 'them'}.`);
  return notes.join(' ') || null;
}

async function runParts(interview, { ask, timeoutMs }) {
  const all = splitTranscript(interview.transcript);
  const parts = all.slice(0, MAX_PARTS);
  const folded = foldForQuote(interview.transcript);
  const system = buildSystemPrompt(interview.contextCategory);
  const dropped = emptyDropped();
  const claims = [];
  let repaired = 0;
  let model = null;
  for (let i = 0; i < parts.length; i++) {
    const user = buildUserMessage({
      contextName: interview.contextName, template: interview.contextCategory, intervieweeName: interview.intervieweeName,
      interviewedAt: interview.interviewedAt, part: i + 1, parts: parts.length, text: parts[i],
    });
    const answer = await askPart([{ role: 'system', content: system }, { role: 'user', content: user }], folded, { ask, timeoutMs });
    claims.push(...answer.claims);
    dropped.invalid += answer.dropped.invalid;
    dropped.quote += answer.dropped.quote;
    for (const [f, n] of Object.entries(answer.dropped.fields)) dropped.fields[f] = (dropped.fields[f] ?? 0) + n;
    repaired += answer.repaired;
    model = answer.model ?? model;
  }
  return { claims, dropped, repaired, model, partsRead: parts.length, partsTotal: all.length };
}

export async function extractInterview(interviewId, { db = defaultDb, ask = defaultAsk, enabled = llmConfigured, timeoutMs = chatTimeoutMs() } = {}) {
  const interview = await store.loadForExtraction(db, interviewId);
  if (!interview) return { status: 'missing', claims: 0, message: null };
  if (!enabled()) {
    const message = 'No local model is configured, so nothing was extracted. Add claims by hand from the transcript.';
    await store.setExtraction(db, interviewId, { status: 'notConfigured', message });
    return { status: 'notConfigured', claims: 0, message };
  }
  await store.setExtraction(db, interviewId, { status: 'running', started: true });
  try {
    const run = await runParts(interview, { ask, timeoutMs });
    const kept = await store.keptClaims(db, interviewId);
    const fresh = dropOwnNameAliases(dedupeClaims(run.claims, kept), interview.contextName);
    const claims = withQuoteOffsets(withRelevance(deduceRoles(await withSubjects(db, fresh, interview))), interview.transcript);
    await db.tx(async (client) => {
      await store.deleteProposedModelClaims(client, interviewId);
      await store.insertClaims(client, { interviewId, contextId: interview.contextId, proposedBy: 'model' }, claims);
    });
    const message = runMessage(run);
    await store.setExtraction(db, interviewId, { status: 'done', message, model: run.model });
    return { status: 'done', claims: claims.length, message };
  } catch (err) {
    const message = `Extraction failed: ${String(err?.message ?? err).slice(0, 300)}`;
    console.warn(`Context interview ${interviewId}:`, message);
    await store.setExtraction(db, interviewId, { status: 'failed', message });
    return { status: 'failed', claims: 0, message };
  }
}

/** Run an extraction without waiting for it. A failure is stored on the interview, never thrown. */
export function startExtraction(interviewId, deps) {
  return extractInterview(interviewId, deps).catch(err => {
    console.error(`Context interview ${interviewId}: extraction could not run —`, err?.message);
    return { status: 'failed', claims: 0, message: null };
  });
}
