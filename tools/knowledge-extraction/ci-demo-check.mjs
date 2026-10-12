// Knowledge extraction against the REAL demo dataset, in CI (pr-integration.yml).
//
//   node tools/knowledge-extraction/ci-demo-check.mjs --base http://localhost:3001
//
// The stack runs the deterministic fake model (fake-model.mjs, service
// "knowledge-model" in docker-compose.ci.yml), so this proves the product path on
// demo data — upload, extract, resolve against the demo's people and groups,
// findings, idempotent re-run, export, delete — not extraction quality.
// The two flags are switched on for this script only and put back afterwards: the
// rest of the integration run (and the e2e suite) never sees them on.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const BASE = (args[args.indexOf('--base') + 1] ?? 'http://localhost:3001').replace(/\/$/, '');
const API = `${BASE}/api`;
const K = `${API}/org-truth/knowledge`;
const TEXT = readFileSync(fileURLToPath(new URL('./fixtures/demo-interview.nl.txt', import.meta.url)), 'utf8');

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json ?? text };
}

const toggle = (feature, enabled) => call('POST', `${API}/admin/features/toggle`, { feature, enabled });

async function waitForRun(id) {
  for (let i = 0; i < 300; i++) {
    const r = await call('GET', `${K}/runs/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(r.body.status)) return r.body;
    await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error(`run ${id} did not finish in 5 minutes`);
}

async function extract(sourceId) {
  const start = await call('POST', `${K}/sources/${sourceId}/extract`, {});
  check(start.status === 202, `extraction starts (202, got ${start.status} ${JSON.stringify(start.body).slice(0, 200)})`);
  const run = await waitForRun(start.body.id);
  check(run.status === 'completed', `extraction completes (${run.status}${run.error ? `: ${run.error}` : ''})`);
  return run;
}

async function main() {
  const features = (await call('GET', `${API}/features`)).body ?? {};
  const before = { orgTruth: features.orgTruth === true, knowledgeExtraction: features.knowledgeExtraction === true };
  await toggle('orgTruth', true);
  await toggle('knowledgeExtraction', true);
  let sourceId = null;
  try {
    const status = (await call('GET', `${K}/status`)).body;
    check(status.reachable === true && status.model === 'fake-knowledge-model', `the fake model is reachable (${JSON.stringify(status)})`);

    const up = await call('POST', `${K}/sources`, { text: TEXT, displayName: 'CI demo interview', speaker: 'Anna Bakker', observedAt: '2026-10-11' });
    check(up.status === 201, `upload stores the transcript (${up.status})`);
    sourceId = up.body.id;
    const dup = await call('POST', `${K}/sources`, { text: TEXT });
    check(dup.status === 200 && dup.body.duplicate === true && dup.body.id === sourceId, 'the same text again is the same source');

    const run = await extract(sourceId);
    const detail = (await call('GET', `${K}/sources/${sourceId}`)).body;
    const claims = (await call('GET', `${K}/sources/${sourceId}/claims`)).body;
    check(claims.length >= 10, `at least 10 statements (${claims.length})`);
    check(claims.every(c => c.evidence.length > 0 && c.evidence.every(e => detail.textContent.slice(e.startChar, e.endChar) === e.quote)),
      'every statement has a quote that is the source text at its offsets');
    check(!claims.some(c => /beheerder|iedereen/i.test(`${c.subject.label} ${c.object.label}`)), 'the injected instruction produced no statement');

    const mentions = (await call('GET', `${K}/sources/${sourceId}/mentions`)).body;
    const by = (label) => mentions.find(m => m.label === label);
    check(by('Maria Novak')?.candidates.some(c => c.label === 'Maria Novak'), 'Maria Novak is matched to the demo person');
    check(by('SG-Finance')?.candidates.some(c => c.targetType === 'Resource' && c.label === 'SG-Finance'), 'SG-Finance is matched to the demo group');
    check(by('Bakker')?.resolution === 'ambiguous', `"Bakker" stays ambiguous between Anna and Tom Bakker (${by('Bakker')?.resolution})`);
    check(by('Wingtip Partners')?.resolution === 'unmatched', 'an unknown customer stays unmatched');
    check(mentions.every(m => m.candidates.every(c => c.status === 'proposed')), 'nothing is accepted without a reviewer');

    const findings = (await call('GET', `${K}/sources/${sourceId}/findings`)).body;
    const cats = new Set(findings.map(f => f.category));
    check(cats.has('ambiguous-name') && cats.has('unresolved-name') && cats.has('self-correction'), `findings raised (${[...cats].join(', ')})`);

    const again = await extract(sourceId);
    const claims2 = (await call('GET', `${K}/sources/${sourceId}/claims`)).body;
    check(JSON.stringify(claims2.map(c => c.id).sort()) === JSON.stringify(claims.map(c => c.id).sort()), 'a second run adds no duplicates');
    check((again.stats?.pipeline?.cached ?? 0) > 0, 'the second run reuses the first run\'s answers');

    const pkg = (await call('GET', `${K}/sources/${sourceId}/export`)).body;
    check(pkg.externalAiUsed === false && pkg.claims.length === claims.length && pkg.runs.length === 2, 'export holds everything');
    console.log(`(run ${run.id}: ${run.stats?.written?.claims} statements, ${run.stats?.written?.mentions} mentions, ${run.stats?.written?.findings} findings)`);
  } finally {
    if (sourceId) {
      const del = await call('DELETE', `${API}/org-truth/sources/${sourceId}`);
      check(del.status === 200, 'the transcript and everything extracted from it can be deleted');
    }
    await toggle('knowledgeExtraction', before.knowledgeExtraction);
    await toggle('orgTruth', before.orgTruth);
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nknowledge extraction on the demo dataset: all checks passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
