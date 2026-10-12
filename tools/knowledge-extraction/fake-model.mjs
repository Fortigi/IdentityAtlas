// A deterministic stand-in for the local model, for CI and contract tests ONLY.
//
// It speaks the slice of the llama.cpp server API knowledge extraction uses
// (GET /v1/models, GET /health, POST /v1/chat/completions with a JSON-schema reply)
// and answers each pipeline stage from the passage text with fixed Dutch/English
// sentence patterns — so a test can assert exactly what the pipeline stores, and
// the whole flow (upload → extract → resolve → review → export) runs without a model.
// It knows nothing about the evaluation transcripts and must never be used to
// measure extraction quality: that is tools/knowledge-extraction/eval.mjs against a real model.
//
//   node tools/knowledge-extraction/fake-model.mjs [port]     (default 8080)
//   import { createFakeModel } from '.../fake-model.mjs'      → { server, url, close(), calls }
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const MODEL_ID = 'fake-knowledge-model';

const between = (text, start, end) => {
  const a = text.indexOf(start);
  if (a < 0) return '';
  const b = text.indexOf(end, a + start.length);
  return text.slice(a + start.length, b < 0 ? undefined : b).trim();
};

const sentences = (text) => text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);

const APPS = ['Contoso Timesheets', 'FileSync Pro', 'Microsoft Teams', 'Omada'];
const NAME = /\b([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/g;
const GROUP = /\bSG-[A-Za-z0-9-]+\b/g;
const TEAM = /\b((?:[A-Z][a-z]+ )?Team|[A-Z][a-z]+-?(?:commissie|team|afdeling))\b/g;
const SKIP = new Set(['Ik', 'Het', 'De', 'Een', 'Binnen', 'Kun', 'Dank', 'Negeer', 'Interviewer', 'Bakker']);

function mentionsOf(passage) {
  const out = new Map();
  const add = (text, type) => { if (!out.has(text)) out.set(text, { text, type }); };
  for (const app of APPS) if (passage.includes(app)) add(app, 'application');
  for (const m of passage.matchAll(GROUP)) add(m[0], 'team');
  for (const m of passage.matchAll(/klant ([A-Z]\w+(?: [A-Z]\w+)?)/g)) add(m[1], 'customer');
  for (const m of passage.matchAll(TEAM)) add(m[1], 'team');
  for (const m of passage.matchAll(NAME)) {
    const t = m[1];
    if (SKIP.has(t.split(' ')[0]) || [...out.keys()].some(k => k.includes(t))) continue;
    if (t.includes(' ')) add(t, 'person');
  }
  const body = passage.replace(/^Anna Bakker:/, '');
  if (/\bBakker\b/.test(body) && !/Anna Bakker/.test(body)) add('Bakker', 'person');
  return [...out.values()];
}

// subject … verb … object, per sentence; one claim per listed subject.
const RULES = [
  [/^(.+?) (?:zit|zitten) in (?:de groep |het |de )?(.+?)\.?$/, 'memberOf'],
  [/^(.+?) (?:werkt|werken) (?:ook )?voor klant (.+?)(?:,.*)?\.?$/, 'worksForCustomer'],
  [/^(.+?) (?:leidt|leiden) (?:de afdeling |het |de )?(.+?)\.?$/, 'leads'],
  [/^(.+?) is verantwoordelijk voor (?:de )?(.+?)\.?$/, 'responsibleFor'],
  [/^(.+?) gebruikt (.+?) voor .+$/, 'usesApplication'],
];

function claimsOf(passage) {
  const body = passage.replace(/^[A-Z][a-z]+(?: [A-Z][a-z]+)?:\s*/, '');
  const out = [];
  for (const raw of sentences(body)) {
    if (/^Negeer/.test(raw)) continue;
    const s = raw.replace(/^Binnen \w+ /, '').replace(/\.$/, '');
    for (const [re, predicate] of RULES) {
      const m = re.exec(s);
      if (!m) continue;
      const subjects = m[1].split(/ en |, /);
      for (const subject of subjects) {
        out.push({
          subject: subject.replace(/^Het /, ''), predicate, object: m[2].replace(/^klant /, ''),
          qualifier: '', modality: /niet zeker/.test(raw) ? 'uncertain' : 'stated', quote: raw.replace(/\.$/, ''),
        });
      }
      break;
    }
    if (/eerst .+, nee, /.test(raw)) {
      out.push({ subject: 'Security Team', predicate: 'hasProperty', object: 'vijf mensen', qualifier: '', modality: 'correction', quote: raw.replace(/\.$/, '') });
    }
  }
  return out;
}

function topicOf(passage) {
  if (/klant/.test(passage)) return 'customers';
  if (/gebruikt|verantwoordelijk voor [A-Z]/.test(passage)) return 'applications';
  if (/zit in|zitten in|leidt|Team/.test(passage)) return 'membership';
  return 'other';
}

function verdictOf(user) {
  const quote = between(user, '<<<SOURCE', 'SOURCE>>>').toLowerCase();
  const statement = /STATEMENT: (.+)/.exec(user)?.[1] ?? '';
  const [subject, , object] = statement.split(' — ');
  const word = (s) => String(s ?? '').toLowerCase().split(/\s+/)[0];
  return quote.includes(word(subject)) && quote.includes(word(object)) ? 'supported' : 'unsupported';
}

export function answer(user) {
  const passage = between(user, '<<<SOURCE', 'SOURCE>>>');
  if (user.includes('What is this passage mainly about?')) return { topic: topicOf(passage) };
  if (user.includes('List every literal mention')) return { mentions: mentionsOf(passage) };
  if (user.includes('Extract atomic statements from the passage')) return { claims: claimsOf(passage) };
  if (user.includes('Does the evidence ALONE')) return { verdict: verdictOf(user) };
  if (user.includes('Help the interviewer check this transcript')) {
    return { findings: [{ kind: 'question', text: 'Hoeveel mensen zitten er nu in het Security Team?', passages: [4] }] };
  }
  if (user.includes('Extract every atomic statement from the whole transcript')) {
    return { claims: passage.split('\n').flatMap(line => claimsOf(line.replace(/^\[\d+\]\s*/, ''))) };
  }
  return {};
}

export function createFakeModel({ port = 0 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.method === 'GET' && req.url === '/v1/models') return send(200, { data: [{ id: MODEL_ID, loaded: true }] });
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', model: 'ready' });
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body || '{}');
        const user = [...(parsed.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '';
        const reply = answer(user);
        calls.push({ user, reply, maxTokens: parsed.max_tokens });
        return send(200, {
          choices: [{ message: { role: 'assistant', content: JSON.stringify(reply) } }],
          timings: { prompt_n: Math.ceil(user.length / 4), prompt_ms: 1, predicted_n: 10, predicted_ms: 1 },
        });
      }
      return send(404, { error: { message: `not found: ${req.method} ${req.url}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const { port: actual } = server.address();
      resolve({ server, url: `http://127.0.0.1:${actual}`, calls, close: () => new Promise(r => server.close(r)) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? 8080);
  createFakeModel({ port }).then(({ url }) => console.log(`fake knowledge model listening on ${url}`));
}
