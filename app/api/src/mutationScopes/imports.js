// Static import scan for the mutation-scope guard: which files does a scope's test
// list actually load? Dev/CI tooling only, never imported by the server.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, matchesGlob, posix } from 'path';

const SPECIFIER_PATTERNS = [
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimportActual\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Every module specifier a source loads, in order of appearance per pattern. */
export function importSpecifiers(source) {
  const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of code.matchAll(re)) out.push(m[1]);
  }
  return [...new Set(out)];
}

const EXTENSIONS = ['', '.js', '.jsx', '/index.js', '/index.jsx'];

/**
 * The package-relative file a specifier names, or null for a bare package or a
 * file that does not exist. `aliases` maps a prefix such as '@ui/' to a directory.
 */
export function resolveSpecifier(fromFile, spec, aliases, exists) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  } else {
    const alias = Object.keys(aliases).find(a => spec.startsWith(a));
    if (alias) base = posix.join(aliases[alias], spec.slice(alias.length));
  }
  if (base === null || base.startsWith('..')) return null;
  for (const ext of EXTENSIONS) {
    if (exists(base + ext)) return base + ext;
  }
  return null;
}

function walkFiles(pkgDir, rel, acc) {
  const full = join(pkgDir, rel);
  if (!existsSync(full)) return acc;
  for (const entry of readdirSync(full)) {
    const child = `${rel}/${entry}`;
    if (statSync(join(pkgDir, child)).isDirectory()) walkFiles(pkgDir, child, acc);
    else acc.push(child);
  }
  return acc;
}

/** Every file under the package's src/, package-relative. */
export const srcFiles = pkgDir => walkFiles(pkgDir, 'src', []);

/**
 * The files under `pkgDir` that a scope's test list (paths or globs) selects.
 * Pass `files` (from srcFiles) to reuse one directory walk across calls.
 */
export function expandTests(pkgDir, patterns, files) {
  const literal = patterns.filter(p => !/[*?{[]/.test(p));
  const globs = patterns.filter(p => /[*?{[]/.test(p));
  const out = new Set(literal.filter(p => existsSync(join(pkgDir, p))));
  if (globs.length) {
    for (const f of files ?? srcFiles(pkgDir)) {
      if (globs.some(g => matchesGlob(f, g))) out.add(f);
    }
  }
  return [...out].sort();
}

/** Files a module imports directly, package-relative. */
function importsOf(pkgDir, file, aliases) {
  const exists = rel => existsSync(join(pkgDir, rel)) && statSync(join(pkgDir, rel)).isFile();
  const specs = importSpecifiers(readFileSync(join(pkgDir, file), 'utf8'));
  return specs.map(s => resolveSpecifier(file, s, aliases, exists)).filter(Boolean);
}

/**
 * Every package file the tests load, directly or through the files they import.
 * A mutant is only killable by a test that reaches its file, and mount tests reach
 * components through a page, so the walk is transitive.
 */
export function reachableFrom(pkgDir, testFiles, aliases = {}) {
  const seen = new Set();
  const queue = [...testFiles];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of importsOf(pkgDir, f, aliases)) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

/** Mutated files that no listed test reaches. */
export function unreachedMutated(mutate, reached) {
  return mutate.filter(m => !m.startsWith('!') && !reached.has(m));
}

// Import aliases per package, as the generated Vitest configs define them.
export const ALIASES = { api: {}, ui: { '@ui/': 'src' } };

/**
 * For one scope: the `tests` entries that select no file, and the mutated files no
 * selected test reaches. Either means something is measured against nothing.
 */
export function scopeReach(root, { pkg, cfg }) {
  const pkgDir = join(root, 'app', pkg);
  const tests = cfg.tests ?? [];
  const files = srcFiles(pkgDir);
  const deadEntries = tests.filter(t => expandTests(pkgDir, [t], files).length === 0);
  const reached = reachableFrom(pkgDir, expandTests(pkgDir, tests, files), ALIASES[pkg]);
  return { deadEntries, unreached: unreachedMutated(cfg.mutate ?? [], reached) };
}
