#!/usr/bin/env node
// Scale test fixture generator — see README.md.
//
//   node tools/scale-dataset/generate.mjs --out ./scale-1pct --scale 0.01
//   node tools/scale-dataset/generate.mjs --out ./scale-full --scale 1 --seed 42
//   node tools/scale-dataset/generate.mjs --out ./x --delimiter semicolon --set crossSystemShare=0.5

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateDataset, generateCommaFixture } from './lib/generate.mjs';
import { resolveDelimiter } from './lib/csvWriter.mjs';
import { DEFAULTS } from './lib/params.mjs';

const USAGE = `Usage: node tools/scale-dataset/generate.mjs --out <dir> [options]
  --scale <n>        volume factor, 0.01 = 1% (default 1)
  --seed <int>       random seed (default ${DEFAULTS.seed})
  --delimiter <d>    tab | comma | semicolon | pipe | <char> (default tab)
  --no-bom           omit the UTF-8 byte-order mark
  --no-comma-fixture skip the comma-delimited column-shift fixture
  --set k=v          override any parameter in lib/params.mjs (repeatable)`;

function parseValue(v) {
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== '' ? n : v;
}

const FLAGS = {
  '--out': (o, v) => { o.out = v; },
  '--scale': (o, v) => { o.overrides.scale = Number(v); },
  '--seed': (o, v) => { o.overrides.seed = Number(v); },
  '--delimiter': (o, v) => { o.delimiter = resolveDelimiter(v); },
  '--set': (o, v) => {
    const eq = v.indexOf('=');
    if (eq < 1 || !(v.slice(0, eq) in DEFAULTS)) throw new Error(`--set expects a known parameter as key=value (got ${v})`);
    o.overrides[v.slice(0, eq)] = parseValue(v.slice(eq + 1));
  },
};

export function parseArgs(argv) {
  const o = { overrides: {}, delimiter: '\t', bom: true, commaFixture: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-bom') { o.bom = false; continue; }
    if (a === '--no-comma-fixture') { o.commaFixture = false; continue; }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (!FLAGS[a]) throw new Error(`Unknown argument ${a}\n${USAGE}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    FLAGS[a](o, argv[++i]);
  }
  if (!o.help && !o.out) throw new Error(`--out is required\n${USAGE}`);
  return o;
}

export async function main(argv, log = (m) => process.stderr.write(`${m}\n`)) {
  const o = parseArgs(argv);
  if (o.help) { log(USAGE); return null; }
  const t0 = Date.now();
  const { manifest } = await generateDataset(o.overrides, o.out, { delimiter: o.delimiter, bom: o.bom, log });
  if (o.commaFixture) {
    await generateCommaFixture(path.join(o.out, 'comma-shift-fixture'), { bom: o.bom });
    log('comma-shift-fixture/: comma-delimited column-shift reproduction written');
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${o.out}`);
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
