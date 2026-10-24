#!/usr/bin/env node
// IdentityIQ-shaped scale fixture generator — see README.md.
//
//   node tools/iiq-fixture/generate.mjs --out ./iiq-1pct --scale 0.01
//   node tools/iiq-fixture/generate.mjs --out ./iiq --scale 0.1 --iiq catalogName=My_Catalog

import { pathToFileURL } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
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

const OPTIONS = {
  out: { type: 'string' },
  scale: { type: 'string' },
  seed: { type: 'string' },
  set: { type: 'string', multiple: true },
  iiq: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
};

export function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseNodeArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new Error(`${err.message}\n${USAGE}`);
  }
  const o = { overrides: { shape: {}, iiq: {} }, out: values.out ?? null, help: values.help === true };
  if (values.scale !== undefined) o.overrides.shape.scale = Number(values.scale);
  if (values.seed !== undefined) o.overrides.shape.seed = Number(values.seed);
  for (const v of values.set ?? []) { const [k, val] = keyValue(v, DEFAULTS, '--set'); o.overrides.shape[k] = val; }
  for (const v of values.iiq ?? []) { const [k, val] = keyValue(v, IIQ_DEFAULTS, '--iiq'); o.overrides.iiq[k] = val; }
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
