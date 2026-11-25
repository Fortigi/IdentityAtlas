// Each JavaScript mutation scope is declared once, in app/{api,ui}/stryker.<scope>.config.json:
// `mutate` (the source files) and `tests` (the tests that run against them, with the
// reasons in `tests_comment`). The Vitest config Stryker runs with,
// vitest.stryker.<scope>.config.js, is generated from it. Dev/CI tooling only.

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export const PACKAGES = ['api', 'ui'];
const SCOPE_FILE = /^stryker\.([a-z0-9-]+)\.config\.json$/;
const GENERATED_FILE = /^vitest\.stryker\.([a-z0-9-]+)\.config\.js$/;

export const vitestFileFor = name => `vitest.stryker.${name}.config.js`;

/** Every scope declaration under `root`, API before UI, by file name. */
export function readScopes(root) {
  const scopes = [];
  for (const pkg of PACKAGES) {
    const dir = join(root, 'app', pkg);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      const m = file.match(SCOPE_FILE);
      if (!m) continue;
      const cfg = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      scopes.push({ pkg, name: m[1], file: `app/${pkg}/${file}`, cfg });
    }
  }
  return scopes;
}

const HEADER = (pkg, name) => [
  `// GENERATED from stryker.${name}.config.json by \`npm run mutation-scopes:generate\``,
  '// (app/api). Do not edit: that file\'s `tests` list is the one declaration of what',
  '// runs against its `mutate` list, and its `tests_comment` says why.',
  '//',
  '// A narrow include, not a growing exclude list: Stryker runs in a sandbox copy of',
  `// app/${pkg}, where a test reading files outside it fails the dry run, and an`,
  '// excluded test that was some mutant\'s only killer would read as a false survivor.',
];

const includeBlock = (tests, indent) =>
  [`${indent}include: [`, ...tests.map(t => `${indent}  '${t}',`), `${indent}],`];

/** The generated Vitest config for one scope. */
export function renderVitestConfig(pkg, name, tests) {
  if (pkg === 'api') {
    return [
      ...HEADER(pkg, name),
      '',
      "import { defineConfig } from 'vitest/config';",
      "import base from './vitest.config.js';",
      '',
      'export default defineConfig({',
      '  ...base,',
      '  test: {',
      '    ...base.test,',
      ...includeBlock(tests, '    '),
      "    exclude: ['**/node_modules/**'],",
      '    coverage: { ...base.test.coverage, thresholds: undefined },',
      '  },',
      '});',
      '',
    ].join('\n');
  }
  return [
    ...HEADER(pkg, name),
    '//',
    '// Standalone rather than spreading vite.config.js: its include reaches',
    '// ../../tools/crawlers/**, outside the sandbox, and its tailwind plugin and',
    "// '@crawlers' alias are build concerns the mutation run does not need.",
    '',
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    "import path from 'path';",
    '',
    'export default defineConfig({',
    '  plugins: [react()],',
    '  resolve: {',
    "    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },",
    '  },',
    '  test: {',
    ...includeBlock(tests, '    '),
    "    exclude: ['**/node_modules/**'],",
    '  },',
    '});',
    '',
  ].join('\n');
}

/** What is wrong with one declaration, as messages; [] when it can be generated. */
export function declarationErrors({ file, name, cfg }) {
  const errors = [];
  const tests = cfg.tests;
  if (!Array.isArray(tests) || tests.length === 0) {
    errors.push(`${file}: \`tests\` must be a non-empty list of test files or globs`);
  } else {
    const bad = tests.filter(t => typeof t !== 'string' || !/^src\/[^'\\]+$/.test(t));
    if (bad.length) errors.push(`${file}: \`tests\` entries must be paths under src/ without quotes: ${bad.join(', ')}`);
    const dupes = tests.filter((t, i) => tests.indexOf(t) !== i);
    if (dupes.length) errors.push(`${file}: \`tests\` lists ${[...new Set(dupes)].join(', ')} more than once`);
  }
  const expected = vitestFileFor(name);
  if (cfg.vitest?.configFile !== expected) {
    errors.push(`${file}: vitest.configFile must be "${expected}" (got "${cfg.vitest?.configFile}")`);
  }
  return errors;
}

const normalise = text => text.replace(/\r\n/g, '\n');

/**
 * Compare the generated files with what the declarations say.
 * Returns { errors, stale: [{ path, text }], orphans } with package-relative paths.
 */
export function plan(root) {
  const scopes = readScopes(root);
  const errors = [];
  const stale = [];
  const declared = new Set();
  for (const scope of scopes) {
    const errs = declarationErrors(scope);
    errors.push(...errs);
    const path = `app/${scope.pkg}/${vitestFileFor(scope.name)}`;
    declared.add(path);
    if (errs.length) continue;
    const text = renderVitestConfig(scope.pkg, scope.name, scope.cfg.tests);
    const full = join(root, path);
    if (!existsSync(full) || normalise(readFileSync(full, 'utf8')) !== text) stale.push({ path, text });
  }
  const orphans = [];
  for (const pkg of PACKAGES) {
    const dir = join(root, 'app', pkg);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (GENERATED_FILE.test(f) && !declared.has(`app/${pkg}/${f}`)) orphans.push(`app/${pkg}/${f}`);
    }
  }
  return { scopes, errors, stale, orphans };
}
