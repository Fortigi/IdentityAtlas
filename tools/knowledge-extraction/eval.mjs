// Score a knowledge-extraction result against a human-checked gold file.
//
//   node tools/knowledge-extraction/eval.mjs --result <result.json> --gold <gold.json> [--source <transcript>] [--out score.json]
//
// <result.json> is either dry-run.mjs --out output or the API export
// (GET /api/org-truth/knowledge/sources/:id/export). <gold.json>:
//   { aliases: { "fortigi": ["fortig", "fortigi"], … },          canonical name → spellings
//     claims:  [{ s, p: "memberOf" | ["memberOf","other"], o, optional?: true }],
//     traps:   [{ s?, p?, o?, note }],                             statements that must NOT appear
//     mentions:[{ label, type, expect?: "candidates"|"unmatched", targetLabel? }] }
//
// A result statement matches a gold claim when its subject and object are the same
// name after aliasing (accents, case, hyphens and a leading article ignored) and its
// predicate is one the gold claim allows. Reported:
//   precision   matched result statements / all result statements (traps count as wrong)
//   recall      matched gold claims / required gold claims
//   evidence    statements whose every quote is a literal substring of the source (with --source)
//   traps       trap hits (should be 0)
//   resolution  for mentions with a targetLabel: is that label among the top-k candidates (export only)
// The gold file must be written BEFORE any prompt tuning and never used to tune prompts.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

export const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/^(de|het|een|the|a) /, '').trim();

export function aliaser(aliases = {}) {
  const map = new Map();
  for (const [canon, spellings] of Object.entries(aliases)) {
    map.set(norm(canon), norm(canon));
    for (const s of spellings) map.set(norm(s), norm(canon));
  }
  return (name) => map.get(norm(name)) ?? norm(name);
}

const allowed = (p) => (Array.isArray(p) ? p : [p]);

// The reviewer's inbox: what is not rejected. The verifier only flags (it never rejects since v2);
// --supported-only scores the statements the verifier agreed with, the 'confident' slice.
const rejectedByVerifier = (c) => c.status === 'rejected'
  || (SUPPORTED_ONLY && (c.evidence ?? []).length > 0 && !c.evidence.some(e => e.support === 'supported'));
const SUPPORTED_ONLY = process.argv.includes('--supported-only');

function statementsOf(result, { inbox = false } = {}) {
  return (result.claims ?? []).filter(c => !inbox || !rejectedByVerifier(c)).map(c => ({
    s: c.subject?.label ?? c.subject, p: c.predicate, o: c.object?.label ?? c.object,
    quotes: (c.evidence ?? []).map(e => e.quote), status: c.status ?? null, support: c.support ?? null,
  }));
}

export function score(result, gold, sourceText = null, { inbox = false } = {}) {
  const a = aliaser(gold.aliases);
  const stmts = statementsOf(result, { inbox });
  const matchesGold = (st, g) => a(st.s) === a(g.s) && a(st.o) === a(g.o) && allowed(g.p).includes(st.p);
  const isTrap = (st) => (gold.traps ?? []).some(t => (!t.s || a(t.s) === a(st.s)) && (!t.o || a(t.o) === a(st.o)) && (!t.p || allowed(t.p).includes(st.p)));
  const matchedGold = new Set();
  let correct = 0;
  let traps = 0;
  const wrong = [];
  for (const st of stmts) {
    if (isTrap(st)) { traps += 1; wrong.push({ ...st, why: 'trap' }); continue; }
    const hit = gold.claims.findIndex(g => matchesGold(st, g));
    if (hit >= 0) { correct += 1; matchedGold.add(hit); } else wrong.push({ ...st, why: 'not in gold' });
  }
  const required = gold.claims.map((g, i) => ({ g, i })).filter(x => !x.g.optional);
  const found = required.filter(x => matchedGold.has(x.i)).length;
  const missed = required.filter(x => !matchedGold.has(x.i)).map(x => x.g);
  const evidenceOk = sourceText == null ? null : stmts.filter(st => st.quotes.length > 0 && st.quotes.every(q => sourceText.includes(q))).length;
  return {
    statements: stmts.length,
    precision: stmts.length ? +(correct / stmts.length).toFixed(3) : null,
    recall: required.length ? +(found / required.length).toFixed(3) : null,
    correct, goldRequired: required.length, goldFound: found, traps,
    evidenceExact: evidenceOk, evidenceTotal: sourceText == null ? null : stmts.length,
    resolution: resolutionScore(result, gold, a),
    missed, wrong,
  };
}

function resolutionScore(result, gold, a) {
  const expect = (gold.mentions ?? []).filter(m => m.targetLabel || m.expect);
  const mentions = (result.mentions ?? []).filter(m => Array.isArray(m.candidates));
  if (expect.length === 0 || mentions.length === 0) return null;
  let top1 = 0; let top3 = 0; let abstainOk = 0; let checked = 0;
  for (const e of expect) {
    const m = mentions.find(x => a(x.label) === a(e.label));
    if (!m) continue;
    checked += 1;
    const labels = m.candidates.map(c => a(c.label));
    if (e.targetLabel) {
      if (labels[0] === a(e.targetLabel)) top1 += 1;
      if (labels.slice(0, 3).includes(a(e.targetLabel))) top3 += 1;
    } else if (e.expect === 'unmatched' && m.candidates.length === 0) abstainOk += 1;
  }
  return { checked, top1, top3, abstainOk };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` || process.argv[1]?.endsWith('eval.mjs')) {
  const result = JSON.parse(readFileSync(opt('--result'), 'utf8'));
  const gold = JSON.parse(readFileSync(opt('--gold'), 'utf8'));
  const source = opt('--source') ? readFileSync(opt('--source'), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n') : null;
  const s = score(result, gold, source);
  const inbox = score(result, gold, source, { inbox: true });
  if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify({ all: s, inbox }, null, 2));
  console.log(`all statements ${s.statements} · precision ${s.precision} · recall ${s.recall} (${s.goldFound}/${s.goldRequired}) · traps ${s.traps} · evidence ${s.evidenceExact ?? '-'}/${s.evidenceTotal ?? '-'}`);
  console.log(`reviewer inbox ${inbox.statements} · precision ${inbox.precision} · recall ${inbox.recall} (${inbox.goldFound}/${inbox.goldRequired}) · traps ${inbox.traps}`);
  if (s.resolution) console.log(`resolution: top1 ${s.resolution.top1}, top3 ${s.resolution.top3}, abstained correctly ${s.resolution.abstainOk} of ${s.resolution.checked}`);
}
