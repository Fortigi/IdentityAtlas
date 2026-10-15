// `npm run ontology:check` / `npm run ontology:generate` (app/api).
//
//   check     parse /ontology/core.ttl, then run every deterministic check:
//             integrity, agreement with the code's registries, known gaps,
//             data-model diagrams in docs/, and freshness of the generated
//             reference page. Exit 1 on any finding.
//   generate  rewrite docs/reference/core-model.md and every generated
//             Mermaid region in docs/ from the ontology.
//
// The comparison with a real migrated database runs in the contract tests
// (contract-tests/coreOntology.contract.test.js), which have PostgreSQL.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildModel, parseOntology } from './model.js';
import { checkIntegrity } from './checks/integrity.js';
import { checkImplementation } from './checks/implementation.js';
import { applyKnownGaps } from './checks/knownGaps.js';
import { checkDiagrams, diagramInventory, renderGeneratedRegions } from './docsDiagrams.js';
import { GENERATED_DIAGRAMS } from './mermaid.js';
import { renderReference } from './referenceDoc.js';
import { loadRegistry } from './registry.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const PATHS = {
  ontology: 'ontology/core.ttl',
  config: 'ontology/validation.json',
  reference: 'docs/reference/core-model.md',
  docs: 'docs',
};

const read = (root, rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');

function markdownFiles(root, dir = PATHS.docs) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...markdownFiles(root, rel));
    else if (name.endsWith('.md')) out.push(rel);
  }
  return out.sort();
}

/** Parse and flatten the ontology under `root`. Returns { model } or { errors }. */
export function loadOntology(root = REPO_ROOT) {
  const parsed = parseOntology(read(root, PATHS.ontology), PATHS.ontology);
  return parsed.errors ? { errors: parsed.errors } : { model: buildModel(parsed.store) };
}

/** Load ontology/validation.json (out-of-scope entities, known gaps). */
export function loadConfig(root = REPO_ROOT) {
  return JSON.parse(read(root, PATHS.config));
}

function docsFindings(root, model) {
  const files = markdownFiles(root).map(path => ({ path, text: read(root, path) }));
  const out = checkDiagrams(files, model, GENERATED_DIAGRAMS);
  const expected = renderReference(model);
  const committed = files.find(f => f.path === PATHS.reference)?.text;
  if (committed !== expected) {
    out.push({ code: 'reference-stale', subject: PATHS.reference, message: committed === undefined ? 'the generated reference page is missing — run npm run ontology:generate' : 'out of date with the ontology — run npm run ontology:generate' });
  }
  return { findings: out, inventory: diagramInventory(files) };
}

/**
 * Run every static check. `registry` can be injected (tests); it defaults to
 * the live code registries.
 * @returns {{ errors: object[], accepted: object[], inventory: object[] }}
 */
export function runCheck({ root = REPO_ROOT, registry = loadRegistry() } = {}) {
  const loaded = loadOntology(root);
  if (loaded.errors) return { errors: loaded.errors, accepted: [], inventory: [] };
  const config = loadConfig(root);
  const { findings, inventory } = docsFindings(root, loaded.model);
  const all = [
    ...checkIntegrity(loaded.model),
    ...checkImplementation(loaded.model, registry, config),
    ...findings,
  ];
  return { ...applyKnownGaps(all, config.knownGaps, 'static'), inventory };
}

/** Rewrite the generated docs. Returns the paths it changed. */
export function runGenerate({ root = REPO_ROOT } = {}) {
  const loaded = loadOntology(root);
  if (loaded.errors) return { errors: loaded.errors, changed: [] };
  const changed = [];
  const write = (rel, text) => {
    let before = null;
    try { before = read(root, rel); } catch { /* new file */ }
    if (before !== text) { writeFileSync(join(root, rel), text); changed.push(rel); }
  };
  write(PATHS.reference, renderReference(loaded.model));
  const errors = [];
  for (const rel of markdownFiles(root).filter(p => p !== PATHS.reference)) {
    const { text, unknown } = renderGeneratedRegions(read(root, rel), loaded.model, GENERATED_DIAGRAMS);
    for (const id of unknown) errors.push({ code: 'diagram-unknown-generator', subject: rel, message: `no generator named "${id}" (or its END marker is missing)` });
    write(rel, text);
  }
  return { errors, changed };
}

const format = (e) => `  ${e.code.padEnd(30)} ${e.subject}\n  ${' '.repeat(30)} ${e.message}`;

/** CLI entry point; returns the process exit code. */
export function main(argv, io = console, opts = {}) {
  const cmd = argv[0];
  if (cmd === 'check') {
    const { errors, accepted } = runCheck(opts);
    if (accepted.length) io.log(`${accepted.length} known gap(s) accepted (ontology/validation.json).`);
    if (errors.length) {
      io.error(`Core ontology check failed — ${errors.length} finding(s):\n${errors.map(format).join('\n')}`);
      return 1;
    }
    io.log('Core ontology check passed.');
    return 0;
  }
  if (cmd === 'generate') {
    const { errors, changed } = runGenerate(opts);
    for (const p of changed) io.log(`updated ${relative('.', p) || p}`);
    if (errors.length) { io.error(errors.map(format).join('\n')); return 1; }
    if (!changed.length) io.log('Generated docs already up to date.');
    return 0;
  }
  io.error('usage: node src/ontology/cli.js <check|generate>');
  return 2;
}

/* v8 ignore next 3 -- the process entry point; main() itself is tested */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
