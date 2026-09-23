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
//
// A question may carry `followUps`: further questions asked in the same
// conversation, each with its own expected answer, graded the same way. They
// are asked only when the opening question produced a report, with that
// exchange as history — the way the Ask tab continues a chat.
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

async function ids(spec) {
  const r = await post('run', { spec: { ...spec, columns: ['id'], limit: 5000 } });
  return new Set(r.rows.map(row => row.id));
}

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

if (args.check) {
  for (const q of questions) {
    if (!q.expected) { console.log(`${q.id.padEnd(24)}   expects: ${q.expectKind}`); continue; }
    try {
      const s = await ids(q.expected);
      console.log(`${q.id.padEnd(24)} ${String(s.size).padStart(5)} rows${s.size === 0 ? '   <-- empty (weak test)' : ''}`);
    } catch (e) {
      console.log(`${q.id.padEnd(24)} INVALID: ${e.message}`);
    }
  }
  process.exit(0);
}

const models = String(args.models || '').split(',').filter(Boolean);
if (models.length === 0) { console.error('--models is required'); process.exit(1); }
const outFile = args.out || join(here, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const addTiming = (a, b) => Object.fromEntries(Object.keys(b).map(k => [k, (a?.[k] || 0) + (b[k] || 0)]));
const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

const results = { startedAt: new Date().toISOString(), models: {} };

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

  /** Ask one question (answering clarifications), then grade it. */
  async function askAndGrade(q, history) {
    const started = Date.now();
    let text = q.question;
    let reply;
    let timing;
    let clarifications = [];
    const confirmations = [];
    let error = null;
    try {
      for (let round = 0; round < 3; round++) {
        reply = await post('interpret', { model, question: text, history });
        timing = addTiming(timing, reply.timing || {});
        reply = await settleConfirmations(reply, confirmations);
        // A question whose right answer IS a clarification must not be answered for the model.
        if (reply.kind !== 'clarify' || round === 2 || q.expectKind === 'clarify') break;
        clarifications.push({ question: reply.question, options: reply.options });
        history = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply.raw }];
        text = q.answer || 'Use your best judgement and produce the report.';
      }
    } catch (e) {
      error = e.message;
    }
    const wallMs = Date.now() - started;

    let pass = false;
    let expectedCount = null;
    let actualCount = null;
    if (!error && q.expectKind === 'clarify') {
      pass = reply?.kind === 'clarify';
      if (!pass) error = `expected a clarification, got ${reply?.kind}`;
    } else if (!error && reply?.kind === 'report') {
      try {
        const [exp, act] = await Promise.all([ids(q.expected), ids(reply.spec)]);
        expectedCount = exp.size; actualCount = act.size;
        pass = sameSet(exp, act);
      } catch (e) { error = `run: ${e.message}`; }
    } else if (!error) {
      error = reply?.kind === 'clarify' ? 'kept asking questions' : (reply?.message || 'no report');
    }
    const columnsOk = q.expectColumns ? q.expectColumns.every(c => reply?.spec?.columns?.includes(c)) : null;

    const row = {
      id: q.id, pass, weak: expectedCount === 0, ambiguous: !!q.ambiguous,
      clarified: clarifications.length > 0 || (q.expectKind === 'clarify' && reply?.kind === 'clarify'), clarifications, columnsOk,
      expectClarify: q.expectKind === 'clarify',
      confirmations,
      replyQuestion: reply?.kind === 'clarify' ? reply.question : undefined,
      expectedCount, actualCount, error, repaired: !!reply?.repaired, wallMs, timing,
      explanation: reply?.explanation, assumptions: reply?.assumptions, spec: reply?.spec,
    };
    rows.push(row);
    const flag = pass ? 'PASS' : 'FAIL';
    console.log(`${flag} ${q.id.padEnd(24)} ${(wallMs / 1000).toFixed(1).padStart(6)}s ` +
      `${row.clarified ? '[asked] ' : ''}${row.repaired ? '[repaired] ' : ''}${confirmations.length ? `[confirmed ${confirmations.map(c => c.chose).join(', ')}] ` : ''}` +
      `${error ? `error: ${error}` : `rows ${actualCount}/${expectedCount}`}`);
    results.models[model] = { warmMs, rows };
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    return { reply, text, history };
  }

  for (const q of questions) {
    const opening = await askAndGrade(q, []);
    // Follow-ups continue the same chat. An opening that produced no report
    // has nothing to follow up on; they are recorded as errors, not skipped,
    // so the totals stay comparable between runs.
    let history = opening.history;
    let last = opening;
    for (const [i, fu] of (q.followUps ?? []).entries()) {
      const id = `${q.id}>${i + 1}`;
      if (last.reply?.kind !== 'report') {
        rows.push({ id, pass: false, weak: false, ambiguous: false, clarified: false, clarifications: [], columnsOk: null,
          expectClarify: false, confirmations: [], expectedCount: null, actualCount: null,
          error: 'no report to follow up on', repaired: false, wallMs: 0, timing: undefined });
        console.log(`FAIL ${id.padEnd(24)}    0.0s error: no report to follow up on`);
        continue;
      }
      history = [...history, { role: 'user', content: last.text }, { role: 'assistant', content: last.reply.raw }];
      last = await askAndGrade({ ...fu, id }, history);
    }
  }

  const graded = rows.filter(r => !r.weak);
  const lat = rows.filter(r => !r.error).map(r => r.wallMs);
  results.models[model].summary = {
    pass: rows.filter(r => r.pass).length,
    total: rows.length,
    passNonWeak: graded.filter(r => r.pass).length,
    totalNonWeak: graded.length,
    askedWhenAmbiguous: rows.filter(r => r.ambiguous && r.clarified).length,
    ambiguous: rows.filter(r => r.ambiguous).length,
    askedWhenClear: rows.filter(r => !r.ambiguous && !r.expectClarify && r.clarified).length,
    errors: rows.filter(r => r.error).length,
    repaired: rows.filter(r => r.repaired).length,
    medianSeconds: +(pct(lat, 0.5) / 1000).toFixed(1),
    p90Seconds: +(pct(lat, 0.9) / 1000).toFixed(1),
    avgOutputTokens: Math.round(rows.reduce((s, r) => s + (r.timing?.outputTokens || 0), 0) / rows.length),
    warmSeconds: +(warmMs / 1000).toFixed(1),
  };
  writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(results.models[model].summary);
}

console.log(`\nresults: ${outFile}`);
console.log('\n| model | correct | correct (non-empty) | asked when ambiguous | asked when clear | errors | median s | p90 s | warm-up s |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [m, { summary: s }] of Object.entries(results.models)) {
  console.log(`| ${m} | ${s.pass}/${s.total} | ${s.passNonWeak}/${s.totalNonWeak} | ${s.askedWhenAmbiguous}/${s.ambiguous} | ${s.askedWhenClear} | ${s.errors} | ${s.medianSeconds} | ${s.p90Seconds} | ${s.warmSeconds} |`);
}
