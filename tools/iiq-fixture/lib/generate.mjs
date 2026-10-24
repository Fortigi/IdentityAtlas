// One fixture run: resolve parameters → the shared plan → every table's bcp
// file → manifest.json. The manifest's `shape` is the scale-dataset fixture's
// own planStats, so comparing it with that fixture's manifest shows the two
// describe the same dataset.

import fs from 'node:fs';
import path from 'node:path';
import { buildPlan, planStats } from '../../scale-dataset/lib/plan.mjs';
import { resolveIiqParams } from './params.mjs';
import { makeContext } from './rows.mjs';
import { WRITERS } from './emit.mjs';
import { TABLES, LOAD_ORDER, FIELD_TERMINATOR, ROW_TERMINATOR } from './tables.mjs';

export async function generateFixture(overrides, outDir, { log = () => {} } = {}) {
  const { shape, iiq } = resolveIiqParams(overrides);
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const plan = buildPlan(shape);
  const ctx = makeContext(plan, iiq);
  log(`plan built in ${Date.now() - t0} ms`);
  const tables = [];
  for (const write of WRITERS) {
    const t = Date.now();
    const results = [].concat(await write(ctx, outDir));
    for (const r of results) {
      tables.push(r);
      log(`${r.table}: ${r.rows.toLocaleString('en-US')} rows, ${(r.bytes / 1048576).toFixed(1)} MB, ${Date.now() - t} ms`);
    }
  }
  tables.sort((a, b) => LOAD_ORDER.indexOf(a.table) - LOAD_ORDER.indexOf(b.table));
  const manifest = {
    generator: 'tools/iiq-fixture',
    format: { fieldTerminator: FIELD_TERMINATOR.charCodeAt(0), rowTerminator: ROW_TERMINATOR.charCodeAt(0), header: false, encoding: 'utf-8' },
    params: { shape, iiq },
    tables: tables.map(({ table, rows, bytes }) => ({ table, rows, bytes, columns: TABLES[table] })),
    shape: planStats(plan),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
