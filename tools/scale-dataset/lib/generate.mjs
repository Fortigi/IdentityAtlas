// Orchestrates one fixture run: resolve parameters → build the plan → stream every
// file → write manifest.json. Files are emitted in the crawler's documented load
// order (systems, contexts, resources, context members, users, assignments).

import fs from 'node:fs';
import path from 'node:path';
import { resolveParams } from './params.mjs';
import { buildPlan, planStats } from './plan.mjs';
import { writeSystems, writeContexts, writeResources, writeContextMembers, writeUsers, writeAssignments } from './emit.mjs';

export const EMITTERS = Object.freeze([
  writeSystems, writeContexts, writeResources, writeContextMembers, writeUsers, writeAssignments,
]);

// Parameters of the small comma-delimited fixture that reproduces the column
// shift in the crawler's fast CSV path (every entitlement value is a DN).
export const COMMA_FIXTURE = Object.freeze({
  seed: 7, scale: 1, connectors: 3, logicalApplications: 3, principals: 12, entitlements: 12, roles: 2,
  entitlementAssignments: 40, roleAssignments: 4, directoryConnectorShare: 1, nameCollisionShare: 0,
});

export async function generateDataset(overrides, outDir, { delimiter = '\t', bom = true, log = () => {} } = {}) {
  const params = resolveParams(overrides);
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const plan = buildPlan(params);
  log(`plan built in ${Date.now() - t0} ms`);
  const files = [];
  for (const emit of EMITTERS) {
    const t = Date.now();
    const result = await emit(plan, outDir, { delimiter, bom });
    files.push({ ...result, ms: Date.now() - t });
    const rss = (process.memoryUsage().rss / 1048576).toFixed(0);
    log(`${result.file}: ${result.rows.toLocaleString('en-US')} rows, ${(result.bytes / 1048576).toFixed(1)} MB, ${Date.now() - t} ms, rss ${rss} MB`);
  }
  const manifest = {
    generator: 'tools/scale-dataset',
    delimiter,
    bom,
    params,
    files: files.map(({ file, rows, bytes }) => ({ file, rows, bytes })),
    shape: planStats(plan),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, timings: files.map(({ file, ms }) => ({ file, ms })) };
}

export function generateCommaFixture(outDir, opts = {}) {
  return generateDataset(COMMA_FIXTURE, outDir, { ...opts, delimiter: ',' });
}
