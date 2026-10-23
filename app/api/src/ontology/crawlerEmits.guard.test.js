// Guard: what the crawler code writes is what its manifest declares.
//
// npm run ontology:check compares each crawler.json `emits` block with the
// ontology (checks/crawlers.js). That only means something if the block is
// complete, so this scans each crawler's sources for the type literals they
// write — `resourceType = 'X'`, `contextType: 'X'`, `principalType = 'X'` in
// PowerShell and JavaScript — and requires each one to be in that crawler's
// emits. A value built at run time or taken from source data cannot be found
// this way; that is what `emits.open` declares.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { REPO_ROOT } from './cli.js';

const CRAWLERS = join(REPO_ROOT, 'tools', 'crawlers');
const LITERAL = /\b(resourceType|contextType|principalType)\s*(?:=|:)(?!=)\s*['"]([A-Z][A-Za-z]+)['"]/g;
const FIELD_KEY = { principalType: 'principalTypes', resourceType: 'resourceTypes', contextType: 'contextTypes' };
const SOURCE = /\.(?:ps1|psm1|js|jsx|mjs)$/;
const NOT_PRODUCT = /(?:\.test\.|\.spec\.|[\\/]Test-|[\\/]Seed-|node_modules|[\\/]results[\\/])/;

// The demo crawler runs the demo dataset generator, which lives outside its folder.
const EXTRA_SOURCES = { demo: ['test/demo-dataset'] };
// Files whose type literals are not writes. Each needs a reason.
const NOT_EMISSIONS = {
  'custom-connector/ConfigWizard.jsx': 'sample payloads shown to the operator; the connector itself writes nothing',
};

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (NOT_PRODUCT.test(p)) return [];
    if (statSync(p).isDirectory()) return files(p);
    return SOURCE.test(n) ? [p] : [];
  });
}

function manifests() {
  return readdirSync(CRAWLERS)
    .filter(d => existsSync(join(CRAWLERS, d, 'crawler.json')))
    .map(d => ({ dir: d, manifest: JSON.parse(readFileSync(join(CRAWLERS, d, 'crawler.json'), 'utf8')) }));
}

function literalsOf(dir, type) {
  const roots = [join(CRAWLERS, dir), ...(EXTRA_SOURCES[type] ?? []).map(r => join(REPO_ROOT, r))];
  const out = [];
  for (const file of roots.flatMap(files)) {
    const rel = relative(CRAWLERS, file).replace(/\\/g, '/');
    if (rel in NOT_EMISSIONS) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(LITERAL)) out.push({ field: m[1], value: m[2], where: `${rel}:${i + 1}` });
    });
  }
  return out;
}

describe('crawler manifests declare the types their code writes', () => {
  const all = manifests();

  it('every crawler manifest has an emits block', () => {
    expect(all.length).toBeGreaterThan(5);
    expect(all.filter(m => !m.manifest.emits).map(m => m.dir)).toEqual([]);
  });

  it('every type literal in a crawler\'s sources is in its emits', () => {
    const found = all.flatMap(({ dir, manifest }) => literalsOf(dir, manifest.type).map(l => ({ ...l, manifest })));
    // Guard against a vacuous pass: the scan must see well-known writes.
    expect(found.filter(f => f.field === 'resourceType').map(f => f.value)).toEqual(expect.arrayContaining(['Group', 'AzureRoleAssignment', 'Entitlement']));
    const undeclared = found
      .filter(f => !f.manifest.emits[FIELD_KEY[f.field]].includes(f.value))
      .map(f => `${f.where}: ${f.field} '${f.value}' (add it to ${f.manifest.type}'s emits.${FIELD_KEY[f.field]} and to ontology/core.ttl)`);
    expect(undeclared).toEqual([]);
  });

  it('every exempted file still exists', () => {
    for (const rel of Object.keys(NOT_EMISSIONS)) expect(existsSync(join(CRAWLERS, rel)), rel).toBe(true);
  });
});
