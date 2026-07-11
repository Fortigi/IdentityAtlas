// Vitest config used ONLY by Stryker mutation testing (stryker.conf.json).
//
// Stryker copies the project into a sandbox dir and re-runs the suite per mutant,
// so the run must be hermetic and fast. It therefore includes ONLY the unit tests
// that cover the modules under mutation (see `mutate` in stryker.conf.json) — the
// DB-free, filesystem-free ingest suite — NOT the whole src tree, the Postgres
// contract suite, or the cross-tree tools/crawlers/** tests.
//
// Growing the mutation scope: when you add a module to `mutate` in
// stryker.conf.json, add the glob for the unit tests that cover it here too.
// Only add DB-free / filesystem-free suites — anything needing Postgres belongs
// in the contract suite and is out of scope for mutation testing.
//
// Normal `npm test` keeps using vitest.config.js (the full unit suite).
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@api': path.resolve(__dirname, 'src') },
  },
  test: {
    include: ['src/ingest/**/*.test.js'],
    exclude: [
      '**/node_modules/**',
      // Static emission-scan guards (assignmentTypes/resourceTypes/…) walk the
      // repo-root tools/crawlers tree — they ENOENT in the Stryker sandbox and
      // cover none of the mutated logic. Glob-exclude so new *.guard.test.js
      // files don't silently break the mutation run.
      'src/ingest/**/*.guard.test.js',
    ],
  },
});
