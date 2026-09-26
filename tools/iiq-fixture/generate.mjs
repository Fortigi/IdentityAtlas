#!/usr/bin/env node
// IdentityIQ-shaped scale fixture generator — see README.md.
//
//   node tools/iiq-fixture/generate.mjs --out ./iiq-1pct --scale 0.01
//   node tools/iiq-fixture/generate.mjs --out ./iiq --scale 0.1 --iiq catalogName=My_Catalog

import { pathToFileURL } from 'node:url';
import { generateFixture } from './lib/generate.mjs';
import { DEFAULTS } from '../scale-dataset/lib/params.mjs';
import { IIQ_DEFAULTS } from './lib/params.mjs';

const USAGE = `Usage: node tools/iiq-fixture/generate.mjs --out <dir> [options]
  --scale <n>     volume factor, 0.01 = 1% (default 1)
  --seed <int>    random seed (default ${DEFAULTS.seed}); same seed = same dataset as tools/scale-dataset
  --set k=v       override a SHAPE parameter (tools/scale-dataset/lib/params.mjs), repeatable
  --iiq k=v       override an IdentityIQ parameter (lib/params.mjs), repeatable`;

function parseValue(v) {
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== '' ? n : v;
}

function keyValue(v, known, flag) {
  const eq = v.indexOf('=');
  if (eq < 1 || !(v.slice(0, eq) in known)) throw new Error(`${flag} expects a known parameter as key=value (got ${v})`);
  return [v.slice(0, eq), parseValue(v.slice(eq + 1))];
}

const FLAGS = {
  '--out': (o, v) => { o.out = v; },
  '--scale': (o, v) => { o.overrides.shape.scale = Number(v); },
  '--seed': (o, v) => { o.overrides.shape.seed = Number(v); },
  '--set': (o, v) => { const [k, val] = keyValue(v, DEFAULTS, '--set'); o.overrides.shape[k] = val; },
  '--iiq': (o, v) => { const [k, val] = keyValue(v, IIQ_DEFAULTS, '--iiq'); o.overrides.iiq[k] = val; },
};

export function parseArgs(argv) {
  const o = { overrides: { shape: {}, iiq: {} }, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
  const manifest = await generateFixture(o.overrides, o.out, { log });
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${o.out}`);
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
