// Run stages 0–4 and 6 of knowledge extraction on a transcript file, without a
// database: prints mentions, statements and findings. Against the fake model by
// default; pass --model-url to read with a real llama.cpp server (e.g. a sidekick's
// report generator reached through an SSH tunnel).
//
//   node tools/knowledge-extraction/dry-run.mjs <transcript> [--model-url http://127.0.0.1:8080] [--mode single] [--out result.json] [--cache answers.json]
// --cache keeps the model's answers between runs: a changed prompt re-asks only its own stage.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createFakeModel } from './fake-model.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!file) { console.error('usage: dry-run.mjs <transcript> [--model-url URL] [--mode pipeline|single] [--out file]'); process.exit(2); }

let fake = null;
if (!opt('--model-url')) fake = await createFakeModel();
process.env.ORG_KNOWLEDGE_LLM_URL = opt('--model-url') ?? fake.url;

const { prepareTranscript } = await import('../../app/api/src/orgtruth/knowledge/ingest.js');
const { runPipeline } = await import('../../app/api/src/orgtruth/knowledge/pipeline.js');
const { ask } = await import('../../app/api/src/orgtruth/knowledge/model.js');

const buffer = readFileSync(file);
const prepared = prepareTranscript({ buffer, fileName: file, fields: { language: null, speaker: null, classification: 'internal', sourceType: 'interview', note: null } });
if (prepared.error) { console.error(prepared.error); process.exit(1); }
const cacheFile = opt('--cache');
const cache = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const started = Date.now();
const result = await runPipeline({
  passages: prepared.passages, ask, mode: opt('--mode') ?? 'pipeline', cache, language: prepared.metadata.language,
  onProgress: ({ phase, done, total }) => process.stderr.write(`\r${phase} ${done}/${total} (${Math.round((Date.now() - started) / 1000)} s)   `),
});
process.stderr.write('\n');
if (cacheFile) writeFileSync(cacheFile, JSON.stringify(result.cache));
const out = { file, seconds: Math.round((Date.now() - started) / 1000), passages: prepared.passages.length, ...result, cache: undefined };
if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(out, null, 2));
console.log(`passages ${out.passages}, mentions ${result.mentions.length}, statements ${result.claims.length}, findings ${result.findings.length}, ${out.seconds} s`);
for (const c of result.claims) console.log(`  [${c.evidence[0].seq}] ${c.subject} ${c.predicate}${c.qualifier ? `(${c.qualifier})` : ''} ${c.object}  {${c.modality}, ${c.evidence.map(e => e.support).join('/')}}`);
console.log('stats', JSON.stringify(result.stats));
if (fake) await fake.close();
