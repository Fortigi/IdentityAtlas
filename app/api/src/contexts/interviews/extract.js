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
//   3. across parts: drop repeats, and anything already decided in an earlier run;
//   4. match the people named (subjects.js) and set role suggestions (roles.js);
//   5. replace the interview's undecided model claims with these, in one transaction.
// Status: running → done (with a note on what was dropped) or failed (with why).
// Nothing is written to the context: every claim waits for review.

import * as defaultDb from '../../db/connection.js';
import { chat } from '../../nlreports/llm.js';
import { getReportModel } from '../../nlreports/settings.js';
import { withTimeout } from '../upload/aiRefine.js';
import { checkClaim, foldForQuote } from './claims.js';
import { buildSystemPrompt, buildUserMessage, RESPONSE_SCHEMA, MAX_CLAIMS_PER_PART } from './prompt.js';
import { resolveSubjects } from './subjects.js';
import { deduceRoles } from './roles.js';
import * as store from './store.js';

export const PART_CHARS = 10_000;
export const MAX_PARTS = 40;
export const CHAT_TIMEOUT_MS = 180_000;
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
 * Check a parsed reply. { ok: true, claims, dropped: { invalid, quote } } when it
 * is a claims list (bad claims dropped and counted), else { ok: false, error }.
 */
export function checkReply(reply, folded) {
  if (!reply || typeof reply !== 'object' || !Array.isArray(reply.claims)) {
    return { ok: false, error: 'The reply must be one JSON object with a "claims" list.' };
  }
  const dropped = { invalid: 0, quote: 0 };
  const claims = [];
  for (const raw of reply.claims.slice(0, MAX_CLAIMS_PER_PART)) {
    const checked = checkClaim(raw, folded);
    if (checked.claim) claims.push(checked.claim); else dropped[checked.reason]++;
  }
  return { ok: true, claims, dropped };
}

const parse = (content) => { try { return JSON.parse(content); } catch { return null; } };

export async function defaultAsk(messages) {
  const model = await getReportModel().catch(() => undefined);
  const { content } = await chat({ model, messages, schema: RESPONSE_SCHEMA, maxTokens: MAX_REPLY_TOKENS });
  return { content, model: model ?? null };
}

/** One part: ask, and once more with the error when the reply is unusable. */
export async function askPart(messages, folded, { ask = defaultAsk, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
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

/** Holder + match for every claim about a person. */
async function withSubjects(db, claims, interview) {
  const names = [...new Set(claims.map(c => c.subjectName).filter(Boolean))];
  const resolved = await resolveSubjects(db, names, {
    contextId: interview.contextId,
    interviewee: { principalId: interview.principalId, identityId: interview.identityId, name: interview.intervieweeName },
  });
  return claims.map(c => {
    const r = c.subjectName ? resolved.get(c.subjectName) : null;
    return { ...c, principalId: r?.principalId ?? null, identityId: r?.identityId ?? null, subjectMatch: r?.match ?? null };
  });
}

/** The sentence stored with a finished run: what was read and what was left out. Pure. */
export function runMessage({ partsRead, partsTotal, dropped }) {
  const notes = [];
  if (partsRead < partsTotal) notes.push(`Only the first ${partsRead} of ${partsTotal} parts of the transcript were read.`);
  if (dropped.quote) notes.push(`${dropped.quote} claim${dropped.quote === 1 ? ' was' : 's were'} left out because the quote is not in the transcript.`);
  if (dropped.invalid) notes.push(`${dropped.invalid} incomplete claim${dropped.invalid === 1 ? ' was' : 's were'} left out.`);
  return notes.join(' ') || null;
}

async function runParts(interview, { ask, timeoutMs }) {
  const all = splitTranscript(interview.transcript);
  const parts = all.slice(0, MAX_PARTS);
  const folded = foldForQuote(interview.transcript);
  const system = buildSystemPrompt(interview.contextCategory);
  const dropped = { invalid: 0, quote: 0 };
  const claims = [];
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
    model = answer.model ?? model;
  }
  return { claims, dropped, model, partsRead: parts.length, partsTotal: all.length };
}

export async function extractInterview(interviewId, { db = defaultDb, ask = defaultAsk, enabled = llmConfigured, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
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
    const claims = deduceRoles(await withSubjects(db, dedupeClaims(run.claims, kept), interview));
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
