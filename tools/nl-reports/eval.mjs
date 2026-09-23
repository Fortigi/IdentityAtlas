#!/usr/bin/env node
// Natural-language reports (PROTOTYPE) — accuracy + latency evaluation.
//
// For every model × question: ask the running API to interpret the question
// (answering a clarifying question when the model asks one), then run BOTH the
// model's spec and the hand-written expected spec and compare the returned ids.
// Grading on result sets rather than spec shape accepts equivalent spellings
// ("contains Global Administrator" vs "is Global Administrator") and rejects
// specs that look plausible but return different rows.
//
// Usage (on the sidekick, against the running stack):
//   node tools/nl-reports/eval.mjs --check                       # validate expected specs only
//   node tools/nl-reports/eval.mjs --models qwen2.5-coder:3b,qwen3:4b [--file holdout.json] [--only id1,id2] [--out file.json]
//                                  [--max-seconds 300]
//
// What a question may say about its right answer:
//   expected      a definition; the answer is right when it returns the same rows
//   expectKind    'clarify' | 'decline' | 'confirm', or a list of them — the right
//                 answer is not a report at all: a question back, a refusal, or a
//                 "which one did you mean" that finds nobody. No definition then.
//   expectColumns columns the definition must include (reported, not graded)
//   followUps     further questions asked in the same chat, each graded on its
//                 own. Their expected definition may say "@previous" for the ids
//                 the opening question's expected answer returned — the records
//                 "these groups" refers to. They are asked with the exchange as
//                 history AND with the chat id the API uses to remember what it
//                 showed, exactly as the Ask tab does.
//   category      how the summary groups it (question, followup, scope, unknown,
//                 ambiguous, count …); follow-ups are always 'followup'
//   pending       recorded but not run: the engine cannot express it yet
//
// Every answer must arrive within --max-seconds (300): a right answer that took
// six minutes is counted as wrong, because nobody waited for it.
//
// Against a stack with authentication on, pass a bearer token for a signed-in
// analyst (--token or EVAL_TOKEN), or a command that prints one (--token-cmd or
// EVAL_TOKEN_CMD, e.g. `az account get-access-token --resource api://<app id>
// --query accessToken -o tsv`): every call here is a POST, which a read-only
// API key may not make, and warm-up needs data.write.reports besides.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

const BASE = args.base || 'http://localhost:3001';
const MAX_SECONDS = Number(args['max-seconds'] || 300);
// A bearer for a stack with authentication on. Either a fixed token, or a
// command that prints a fresh one (--token-cmd / EVAL_TOKEN_CMD), run before
// every request: a full run outlasts a one-hour token, and a run that dies at
// question 12 of 17 because the token expired measures nothing. The command's
// own caching (az keeps a token until it is about to expire) keeps it cheap.
const TOKEN_CMD = args['token-cmd'] || process.env.EVAL_TOKEN_CMD || '';
const FIXED_TOKEN = args.token || process.env.EVAL_TOKEN || '';
function tokenFor() {
  if (!TOKEN_CMD) return FIXED_TOKEN;
  return execSync(TOKEN_CMD, { encoding: 'utf8', windowsHide: true }).trim();
}
const here = dirname(fileURLToPath(import.meta.url));
let questions = JSON.parse(readFileSync(args.file || join(here, 'questions.json'), 'utf8'));
if (args.only) questions = questions.filter(q => args.only.split(',').includes(q.id));
// Questions that need a capability the engine does not have yet are recorded but not run.
for (const q of questions.filter(x => x.pending)) console.log(`SKIP ${q.id}: ${q.pending}`);
questions = questions.filter(q => !q.pending);

// node:http, not fetch(): fetch gives up after 300 s waiting for response headers,
// and a cold model answering a hard question can take longer than that.
function post(path, body) {
  const payload = JSON.stringify(body);
  const url = new URL(`${BASE}/api/nl-reports/${path}`);
  const token = tokenFor();
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        if (res.statusCode < 200 || res.statusCode >= 300 || !json) {
          reject(new Error(`${path} ${res.statusCode}: ${text.slice(0, 400)}`));
          return;
        }
        resolve(json);
      });
    });
    req.setTimeout(1_200_000, () => req.destroy(new Error(`${path} timed out`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * The rows a definition returns, as a set that can be compared. A record list
 * compares by id; a grouped report (counts per value) by value and count.
 */
async function ids(spec) {
  if (spec.groupBy) {
    const r = await post('run', { spec: { ...spec, columns: [], limit: 5000 } });
    return new Set(r.rows.map(row => Object.entries(row).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k}=${v}`).join('|')));
  }
  const r = await post('run', { spec: { ...spec, columns: ['id'], limit: 5000 } });
  return new Set(r.rows.map(row => row.id));
}

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

/**
 * The records an answer actually puts in front of the caller — the same
 * reading the follow-up bookkeeping uses (nlreports/followUp.js). "Van welke
 * groepen ben ik lid?" is answered two ways that are equally right: 118 group
 * rows, or ONE row (the caller) with a cell listing 118 groups. Row ids say
 * the second is wrong; the caller reading the card says it is the same answer.
 * So an answer is also right when what it shows matches what was expected.
 */
async function shownSets(spec) {
  const r = await post('run', { spec: { ...spec, limit: 5000 } });
  const rows = r.rows ?? [];
  // The rows themselves, and every list column across them: "who are the
  // members of these groups" answered as the groups with a members column
  // shows exactly the members.
  const columns = new Set(rows.flatMap(row => Object.keys(row._links ?? {})));
  const lists = [...columns].map(col => new Set(rows.flatMap(row => (row._links?.[col] ?? []).map(l => l.id))));
  return [new Set(rows.map(row => row._entity?.id).filter(Boolean)), ...lists];
}
const expectedKinds = (q) => (Array.isArray(q.expectKind) ? q.expectKind : (q.expectKind ? [q.expectKind] : []));

/** "@previous" in an expected definition stands for the ids the opening question's expected answer returned. */
function withPrevious(node, previousIds) {
  if (Array.isArray(node)) return node.map(n => withPrevious(n, previousIds));
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === 'value' && v === '@previous' ? previousIds : withPrevious(v, previousIds);
  }
  return out;
}

if (args.check) {
  for (const q of questions) {
    if (!q.expected) { console.log(`${q.id.padEnd(28)}   expects: ${expectedKinds(q).join(' | ')}`); continue; }
    try {
      const s = await ids(q.expected);
      console.log(`${q.id.padEnd(28)} ${String(s.size).padStart(5)} rows${s.size === 0 ? '   <-- empty (weak test)' : ''}`);
      for (const [i, fu] of (q.followUps ?? []).entries()) {
        const f = await ids(withPrevious(fu.expected, [...s]));
        console.log(`${`${q.id}>${i + 1}`.padEnd(28)} ${String(f.size).padStart(5)} rows${f.size === 0 ? '   <-- empty (weak test)' : ''}`);
      }
    } catch (e) {
      console.log(`${q.id.padEnd(28)} INVALID: ${e.message}`);
    }
  }
  process.exit(0);
}

const models = String(args.models || '').split(',').filter(Boolean);
if (models.length === 0) { console.error('--models is required'); process.exit(1); }
const outFile = args.out || join(here, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const runStamp = Date.now().toString(36);

const addTiming = (a, b) => Object.fromEntries(Object.keys(b).map(k => [k, (a?.[k] || 0) + (b[k] || 0)]));
const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const languageOf = (id) => (/-nl(>|$)/.test(id) ? 'nl' : (/-en(>|$)/.test(id) ? 'en' : '-'));

const results = { startedAt: new Date().toISOString(), maxSeconds: MAX_SECONDS, models: {} };

for (const model of models) {
  console.log(`\n=== ${model} ===`);
  const warmStarted = Date.now();
  await post('warm', { model });
  const warmMs = Date.now() - warmStarted;
  console.log(`warm-up (load + read system prompt): ${(warmMs / 1000).toFixed(1)}s`);
  const rows = [];

  /** A "did you mean" confirmation: the simulated analyst accepts the first suggestion.
   *  For a name the report did not use ("ACME"), that is the first field it was found in. */
  async function settleConfirmations(reply, confirmations) {
    while (reply.kind === 'confirm' && reply.confirm.choices.length && confirmations.length < 3) {
      const { confirm } = reply;
      const pick = confirm.choices[0];
      confirmations.push({ kind: confirm.kind, asked: confirm.name, chose: pick.name });
      const choice = confirm.kind === 'term'
        ? { kind: 'term', path: [], name: pick.name, term: confirm.name, fields: pick.fields, drop: confirm.drop }
        : { path: confirm.path, name: pick.name, id: pick.id };
      const resolved = await post('resolve', { spec: reply.spec, choice });
      reply = resolved.confirm
        ? { ...reply, spec: resolved.spec, confirm: resolved.confirm }
        : { ...reply, kind: 'report', spec: resolved.spec, explanation: resolved.explanation };
    }
    return reply;
  }

  /**
   * Ask one question (answering clarifications), then grade it.
   * @returns {{ reply, text, history, expectedIds }} what the next question in the chat builds on
   */
  async function askAndGrade(q, history, conversationId, previousIds = null) {
    const started = Date.now();
    const kinds = expectedKinds(q);
    let text = q.question;
    let reply;
    let timing;
    let clarifications = [];
    const confirmations = [];
    let error = null;
    try {
      for (let round = 0; round < 3; round++) {
        reply = await post('interpret', { model, question: text, history, conversationId });
        timing = addTiming(timing, reply.timing || {});
        // A question whose right answer IS a confirmation must not be answered for the model.
        if (!kinds.includes('confirm')) reply = await settleConfirmations(reply, confirmations);
        // Likewise a question whose right answer IS a clarification.
        if (reply.kind !== 'clarify' || round === 2 || kinds.includes('clarify')) break;
        clarifications.push({ question: reply.question, options: reply.options });
        history = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply.raw }];
        text = q.answer || 'Use your best judgement and produce the report.';
      }
      // What this answer showed, remembered by the API for the next question in
      // the chat — the run the Ask tab makes right after an interpretation.
      if (reply?.kind === 'report') await post('run', { spec: reply.spec, logId: reply.logId, conversationId });
    } catch (e) {
      error = e.message;
    }
    const wallMs = Date.now() - started;

    let pass = false;
    let expectedCount = null;
    let actualCount = null;
    let expectedIds = null;
    let shownAs = null;
    if (!error && kinds.length) {
      pass = kinds.includes(reply?.kind);
      if (!pass) error = `expected ${kinds.join(' or ')}, got ${reply?.kind}${reply?.kind === 'report' ? ' — it answered' : ''}`;
    } else if (!error && reply?.kind === 'report') {
      try {
        const expected = previousIds ? withPrevious(q.expected, previousIds) : q.expected;
        const [exp, act] = await Promise.all([ids(expected), ids(reply.spec)]);
        expectedIds = [...exp];
        expectedCount = exp.size; actualCount = act.size;
        pass = sameSet(exp, act);
        if (!pass && !reply.spec.groupBy) {
          const shown = (await shownSets(reply.spec)).find(set => sameSet(exp, set));
          if (shown) { pass = true; actualCount = shown.size; shownAs = 'a list inside one row'; }
        }
      } catch (e) { error = `run: ${e.message}`; }
    } else if (!error) {
      const said = reply?.kind === 'clarify' ? 'kept asking questions' : (reply?.kind === 'decline' ? `declined: ${reply.reason}` : (reply?.message || 'no report'));
      error = said;
    }
    const slow = wallMs > MAX_SECONDS * 1000;
    if (slow && pass) { pass = false; error = `right, but over the ${MAX_SECONDS}s limit`; }
    const columnsOk = q.expectColumns ? q.expectColumns.every(c => reply?.spec?.columns?.includes(c)) : null;

    const row = {
      id: q.id, category: q.category || 'question', language: languageOf(q.id), pass, slow,
      weak: expectedCount === 0, ambiguous: !!q.ambiguous,
      clarified: clarifications.length > 0 || (kinds.includes('clarify') && reply?.kind === 'clarify'), clarifications, columnsOk,
      expectClarify: kinds.includes('clarify'), expectKinds: kinds,
      confirmations, followedUp: reply?.followedUp, shownAs,
      replyKind: reply?.kind,
      replyQuestion: reply?.kind === 'clarify' ? reply.question : undefined,
      reason: reply?.kind === 'decline' ? reply.reason : undefined,
      expectedCount, actualCount, error, repaired: !!reply?.repaired, wallMs, timing,
      explanation: reply?.explanation, assumptions: reply?.assumptions, spec: reply?.spec,
    };
    rows.push(row);
    const flag = pass ? 'PASS' : 'FAIL';
    console.log(`${flag} ${q.id.padEnd(28)} ${(wallMs / 1000).toFixed(1).padStart(6)}s ` +
      `${row.clarified ? '[asked] ' : ''}${row.repaired ? '[repaired] ' : ''}${row.followedUp ? '[follow-up] ' : ''}${confirmations.length ? `[confirmed ${confirmations.map(c => c.chose).join(', ')}] ` : ''}` +
      `${error ? `error: ${error}` : (kinds.length ? reply.kind : `rows ${actualCount}/${expectedCount}`)}${shownAs ? ` (${shownAs})` : ''}`);
    results.models[model] = { warmMs, rows };
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    return { reply, text, history, expectedIds };
  }

  for (const q of questions) {
    const conversationId = `eval-${runStamp}-${q.id}`.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 100);
    const opening = await askAndGrade(q, [], conversationId);
    // Follow-ups continue the same chat. An opening that produced no report
    // has nothing to follow up on; they are recorded as errors, not skipped,
    // so the totals stay comparable between runs.
    let history = opening.history;
    let last = opening;
    const previousIds = opening.expectedIds;
    for (const [i, fu] of (q.followUps ?? []).entries()) {
      const id = `${q.id}>${i + 1}`;
      if (last.reply?.kind !== 'report') {
        rows.push({ id, category: 'followup', language: languageOf(id), pass: false, slow: false, weak: false, ambiguous: false, clarified: false, clarifications: [], columnsOk: null,
          expectClarify: false, expectKinds: [], confirmations: [], expectedCount: null, actualCount: null,
          error: 'no report to follow up on', repaired: false, wallMs: 0, timing: undefined });
        console.log(`FAIL ${id.padEnd(28)}    0.0s error: no report to follow up on`);
        continue;
      }
      history = [...history, { role: 'user', content: last.text }, { role: 'assistant', content: last.reply.raw }];
      last = await askAndGrade({ ...fu, id, category: 'followup' }, history, conversationId, previousIds);
    }
  }

  const graded = rows.filter(r => !r.weak);
  const lat = rows.filter(r => !r.error || r.slow).map(r => r.wallMs);
  const tally = (list) => `${list.filter(r => r.pass).length}/${list.length}`;
  const byCategory = Object.fromEntries([...new Set(rows.map(r => r.category))].map(c => [c, tally(rows.filter(r => r.category === c))]));
  const byLanguage = Object.fromEntries(['nl', 'en'].map(l => [l, tally(rows.filter(r => r.language === l))]));
  results.models[model].summary = {
    pass: rows.filter(r => r.pass).length,
    total: rows.length,
    passNonWeak: graded.filter(r => r.pass).length,
    totalNonWeak: graded.length,
    byCategory,
    byLanguage,
    overTimeLimit: rows.filter(r => r.slow).length,
    askedWhenAmbiguous: rows.filter(r => r.ambiguous && r.clarified).length,
    ambiguous: rows.filter(r => r.ambiguous).length,
    askedWhenClear: rows.filter(r => !r.ambiguous && !r.expectClarify && r.clarified).length,
    errors: rows.filter(r => r.error).length,
    repaired: rows.filter(r => r.repaired).length,
    medianSeconds: +(pct(lat, 0.5) / 1000).toFixed(1),
    p90Seconds: +(pct(lat, 0.9) / 1000).toFixed(1),
    maxSeconds: +(Math.max(0, ...lat) / 1000).toFixed(1),
    avgOutputTokens: Math.round(rows.reduce((s, r) => s + (r.timing?.outputTokens || 0), 0) / rows.length),
    warmSeconds: +(warmMs / 1000).toFixed(1),
  };
  writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(results.models[model].summary);
}

console.log(`\nresults: ${outFile}`);
console.log(`\n| model | correct | correct (non-empty) | per category | nl / en | over ${MAX_SECONDS}s | asked when ambiguous | asked when clear | errors | median s | p90 s | max s |`);
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [m, { summary: s }] of Object.entries(results.models)) {
  const cats = Object.entries(s.byCategory).map(([c, t]) => `${c} ${t}`).join(', ');
  console.log(`| ${m} | ${s.pass}/${s.total} | ${s.passNonWeak}/${s.totalNonWeak} | ${cats} | ${s.byLanguage.nl} / ${s.byLanguage.en} | ${s.overTimeLimit} | ${s.askedWhenAmbiguous}/${s.ambiguous} | ${s.askedWhenClear} | ${s.errors} | ${s.medianSeconds} | ${s.p90Seconds} | ${s.maxSeconds} |`);
}
