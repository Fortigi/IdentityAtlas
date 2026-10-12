// Organisation knowledge extraction — stages 1–4 and 6 over the passages of ONE
// transcript. No database: the model is injected (`ask`), so every rule here is
// tested with a scripted model, and the runner (run.js) stores the result.
//
//   runPipeline({ passages, ask, cache, onProgress, isCancelled, mode }) → result
//
// Per passage, in this order (the shared prefix stays in the model's cache):
//   1 topic      one of TOPICS; a failure becomes 'other'
//   2 mentions   literal mentions; one the model returns that is not in the passage is dropped
//   3 claims     atomic statements with a verbatim quote, given the passage's mentions
//   4 verify     a) deterministic: the quote must be IN the passage (locateQuote) and
//                   subject + object must occur in it — otherwise the statement is dropped;
//                   lists ("Led, Rob en Mark") are split into one statement per name
//                b) the model, shown ONLY the quote and the statement: supported /
//                   unsupported / unclear. Unsupported statements are kept, marked
//                   rejected by the verifier, so a reviewer can still see them.
// Then once for the whole transcript:
//   6 findings   contradictions, possibly misheard names, follow-up questions — each
//                must cite existing passage numbers
//
// mode 'single' is the evaluation baseline (run A): one prompt over the whole
// transcript, then only the deterministic evidence check (4a).
//
// `cache` maps a question (hash of the system prompt and the exact user message) to
// its validated answer; a resumed run passes the previous run's cache and skips every
// call whose prompt did not change — a reworded claim prompt re-asks only the claims.
import { createHash } from 'node:crypto';
import {
  TOPIC_SCHEMA, MENTION_SCHEMA, CLAIM_SCHEMA, VERIFY_SCHEMA, FINDINGS_SCHEMA, SINGLE_SCHEMA,
  checkTopic, checkMentions, checkClaims, checkVerdict, checkFindings, MENTION_TYPES, LIMITS,
} from './contracts.js';
import {
  SYSTEM_PROMPT, topicMessage, mentionMessage, claimMessage, verifyMessage, findingsMessage, singleMessage, numbered,
} from './prompts.js';
import { locateQuote, labelKey, mentionedIn, splitList } from './evidence.js';

export class CancelledError extends Error {
  constructor() { super('The extraction was cancelled.'); this.name = 'CancelledError'; }
}

export const MAX_FINDINGS_CHARS = 12_000;
// A passage of a dozen statements is ~1,100 tokens of JSON (measured); 900 cut one off.
export const CLAIM_REPLY_TOKENS = 1600;
// The single-prompt baseline writes the whole transcript's statements in one reply.
export const SINGLE_TIMEOUT_MS = 1_800_000;

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
export const cacheKey = (stage, user) => `${stage}:${hash(`${SYSTEM_PROMPT}\n${user}`)}`;

export const mentionKey = (type, label) => `${type}:${labelKey(label)}`;

// What an unlisted claim side most likely is, by predicate.
const OBJECT_TYPE = {
  memberOf: 'team', formerMemberOf: 'team', partOf: 'organisation', leads: 'team', responsibleFor: 'concept',
  worksForCustomer: 'customer', usesApplication: 'application', hasProperty: 'concept', other: 'concept',
};
// A subject of one or two capitalised words reads as a person ("Rob", "Anna Bakker"),
// anything longer or lowercase as an organisation.
export const defaultType = (predicate, side, label) => {
  if (side === 'object') return OBJECT_TYPE[predicate] ?? 'concept';
  if (predicate === 'partOf') return 'team';
  const words = String(label).trim().split(/\s+/);
  return words.length <= 2 && words.every(w => /^\p{Lu}/u.test(w)) ? 'person' : 'organisation';
};

/** Every literal occurrence of `label` in the passage (case-insensitive), as source offsets. */
export function occurrences(passage, label) {
  const hay = passage.text.toLowerCase();
  const needle = String(label).toLowerCase();
  const out = [];
  if (!needle) return out;
  let at = hay.indexOf(needle);
  while (at >= 0) {
    out.push({ seq: passage.seq, startChar: passage.startChar + at, endChar: passage.startChar + at + needle.length });
    at = hay.indexOf(needle, at + needle.length);
  }
  return out;
}

// Free descriptions (hasProperty, responsibleFor, other) need only most of their words in the text.
const DESCRIPTIVE = new Set(['hasProperty', 'responsibleFor', 'other']);
function grounded(label, text, descriptive) {
  if (mentionedIn(label, text)) return true;
  if (!descriptive) return false;
  const words = labelKey(label).split(' ').filter(w => w.length >= 3);
  const have = new Set(labelKey(text).split(' '));
  return words.length > 0 && words.filter(w => have.has(w)).length / words.length >= 0.5;
}

/** Deterministic part of verification; returns the statements that survive, split per list item. */
export function groundClaims(passage, claims, stats) {
  const out = [];
  for (const c of claims) {
    const ev = locateQuote(passage, c.quote);
    if (!ev) { stats.droppedNoEvidence += 1; continue; }
    for (const subject of splitList(c.subject)) {
      for (const object of splitList(c.object)) {
        if (!grounded(subject, passage.text, false) || !grounded(object, passage.text, DESCRIPTIVE.has(c.predicate))) {
          stats.droppedUngrounded += 1;
          continue;
        }
        out.push({ ...c, subject, object, evidence: { seq: passage.seq, ...ev } });
      }
    }
  }
  return out;
}

function newStats() {
  return {
    calls: 0, cached: 0, failedCalls: 0, repairRounds: 0, ms: 0, promptTokens: 0, outputTokens: 0,
    perStage: {}, droppedNoEvidence: 0, droppedUngrounded: 0, droppedNotLiteral: 0, verifierRejected: 0,
  };
}

// One stage question; the key is the exact prompt, so an unchanged prompt is never asked twice.
async function cachedAsk(ctx, stage, q) {
  const key = cacheKey(stage, q.user);
  if (Object.hasOwn(ctx.cache, key)) {
    ctx.stats.cached += 1;
    return ctx.cache[key];
  }
  if (ctx.isCancelled && await ctx.isCancelled()) throw new CancelledError();
  const started = Date.now();
  // A call that runs out of time is one failed call, like an unusable reply — not
  // the end of the run (measured: one long reply on a 2-vCPU host took > 10 min).
  const res = await ctx.ask(q).catch((err) => {
    if (!/did not answer within/.test(err.message)) throw err;
    return { ok: false, errors: [err.message], rounds: 1, timing: {} };
  });
  const s = ctx.stats;
  const per = (s.perStage[stage] ??= { calls: 0, failed: 0, ms: 0 });
  s.calls += 1; per.calls += 1;
  s.ms += Date.now() - started; per.ms += Date.now() - started;
  s.promptTokens += res.timing?.promptTokens ?? 0;
  s.outputTokens += res.timing?.outputTokens ?? 0;
  if (res.rounds > 1) s.repairRounds += 1;
  if (!res.ok) {
    s.failedCalls += 1; per.failed += 1;
    ctx.errors.push({ stage, errors: res.errors.slice(0, 3) });
    return null; // not cached: a resumed run asks again
  }
  ctx.cache[key] = res.value;
  return res.value;
}

const progress = async (ctx, phase) => {
  ctx.done += 1;
  if (ctx.onProgress) await ctx.onProgress({ phase, done: ctx.done, total: ctx.total });
};

function addMention(ctx, type, label, occ, origin) {
  const key = mentionKey(type, label);
  const m = ctx.mentions.get(key) ?? { key, type, label, occurrences: [], origin };
  for (const o of occ) {
    if (!m.occurrences.some(x => x.startChar === o.startChar)) m.occurrences.push(o);
  }
  ctx.mentions.set(key, m);
  return m;
}

// A claim side → a mention: one already found with the same name (any type), else a new one.
function sideMention(ctx, passage, label, predicate, side) {
  const lk = labelKey(label);
  const found = [...ctx.mentions.values()].find(m => labelKey(m.label) === lk);
  if (found) {
    addMention(ctx, found.type, found.label, occurrences(passage, label), found.origin);
    return found;
  }
  return addMention(ctx, defaultType(predicate, side, label), label, occurrences(passage, label), 'claim');
}

function addClaim(ctx, passage, c, topic) {
  const subject = sideMention(ctx, passage, c.subject, c.predicate, 'subject');
  const object = sideMention(ctx, passage, c.object, c.predicate, 'object');
  const qualifier = c.qualifier ? labelKey(c.qualifier) : '';
  const key = hash(`${subject.key}|${c.predicate}|${object.key}|${qualifier}`);
  const claim = ctx.claims.get(key) ?? {
    key, subjectKey: subject.key, objectKey: object.key, subject: subject.label, object: object.label,
    predicate: c.predicate, qualifier: c.qualifier ?? null, modality: c.modality, topic, evidence: [],
  };
  if (!claim.evidence.some(e => e.startChar === c.evidence.startChar && e.endChar === c.evidence.endChar)) {
    claim.evidence.push({ ...c.evidence, support: c.support ?? 'unchecked', verifier: c.verifier ?? null });
  }
  ctx.claims.set(key, claim);
}

async function passageStages(ctx, p) {
  const topic = (await cachedAsk(ctx, 'topic', { user: topicMessage(p.text), schema: TOPIC_SCHEMA, check: checkTopic, maxTokens: 20 })) ?? 'other';
  ctx.topics[p.seq] = topic;
  await progress(ctx, 'topics');

  const mentions = (await cachedAsk(ctx, 'mentions', { user: mentionMessage(p.text), schema: MENTION_SCHEMA, check: checkMentions, maxTokens: 400 })) ?? [];
  const literal = [];
  for (const m of mentions) {
    const occ = occurrences(p, m.text);
    if (occ.length === 0) { ctx.stats.droppedNotLiteral += 1; continue; }
    addMention(ctx, m.type, m.text, occ, 'model');
    literal.push(m);
  }
  await progress(ctx, 'mentions');

  const claims = (await cachedAsk(ctx, 'claims', { user: claimMessage(p.text, literal), schema: CLAIM_SCHEMA, check: checkClaims, maxTokens: CLAIM_REPLY_TOKENS })) ?? [];
  await progress(ctx, 'claims');

  for (const c of groundClaims(p, claims, ctx.stats)) {
    const verdict = (await cachedAsk(ctx, 'verify', { user: verifyMessage(c, c.evidence.quote), schema: VERIFY_SCHEMA, check: checkVerdict, maxTokens: 20 })) ?? 'unclear';
    if (verdict === 'unsupported') ctx.stats.verifierRejected += 1;
    addClaim(ctx, p, { ...c, support: verdict, verifier: 'model' }, topic);
  }
}

async function findingsStage(ctx, passages) {
  const text = numbered(passages).slice(0, MAX_FINDINGS_CHARS);
  const value = await cachedAsk(ctx, 'findings', {
    user: findingsMessage(text, ctx.language), schema: FINDINGS_SCHEMA, check: (r) => checkFindings(r, passages.length), maxTokens: 900,
  });
  await progress(ctx, 'findings');
  return value ?? [];
}

async function singleStage(ctx, passages) {
  const text = numbered(passages).slice(0, MAX_FINDINGS_CHARS);
  const claims = (await cachedAsk(ctx, 'single', { user: singleMessage(text), schema: SINGLE_SCHEMA, check: (r) => checkClaims(r, LIMITS.claimsSingle), maxTokens: 2500, timeoutMs: SINGLE_TIMEOUT_MS })) ?? [];
  await progress(ctx, 'single');
  for (const c of claims) {
    // The quote decides the passage: the first one it is literally in.
    const p = passages.find(x => locateQuote(x, c.quote));
    if (!p) { ctx.stats.droppedNoEvidence += 1; continue; }
    for (const g of groundClaims(p, [c], ctx.stats)) addClaim(ctx, p, g, null);
  }
}

/**
 * @param {object} args
 * @param {{ seq, startChar, endChar, text }[]} args.passages
 * @param {(q: { user, schema, check, maxTokens }) => Promise<{ ok, value, errors, rounds, timing }>} args.ask
 * @param {object} [args.cache]       previous outputs, mutated in place
 * @param {(p: { phase, done, total }) => Promise|void} [args.onProgress]
 * @param {() => Promise<boolean>|boolean} [args.isCancelled]
 * @param {'pipeline'|'single'} [args.mode]
 * @param {string|null} [args.language]   the transcript's language: the findings are written in it
 */
export async function runPipeline({ passages, ask, cache = {}, onProgress, isCancelled, mode = 'pipeline', language = null }) {
  const ctx = {
    ask, cache, onProgress, isCancelled, language, done: 0, errors: [], stats: newStats(),
    total: mode === 'single' ? 1 : passages.length * 3 + 1,
    topics: {}, mentions: new Map(), claims: new Map(),
  };
  let findings = [];
  if (mode === 'single') {
    await singleStage(ctx, passages);
  } else {
    for (const p of passages) await passageStages(ctx, p);
    findings = await findingsStage(ctx, passages);
  }
  return {
    mode,
    topics: ctx.topics,
    mentions: [...ctx.mentions.values()].filter(m => MENTION_TYPES.includes(m.type)),
    claims: [...ctx.claims.values()],
    findings,
    stats: ctx.stats,
    errors: ctx.errors.slice(0, 50),
    cache: ctx.cache,
  };
}
