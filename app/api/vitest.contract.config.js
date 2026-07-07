// Vitest config for contract tests — runs against a real PostgreSQL container.
// Kept separate from vitest.config.js so normal `npm test` stays fast.
// Run with: npm run test:contract

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@api': path.resolve(__dirname, 'src') },
  },
  test: {
    // *.contract.test.js — SQL-shape tests; *.integration.test.js — full HTTP
    // tests booting the real app against the testcontainers DB with auth enabled.
    include: ['contract-tests/**/*.contract.test.js', 'contract-tests/**/*.integration.test.js'],
    globalSetup: ['./test-utils/contractGlobalSetup.js'],
    // Single worker: contract tests share one DB container; parallelism would
    // require per-test isolation that adds complexity. Keep it simple.
    pool: 'forks',
    forks: { singleFork: true },
    // singleFork puts every file in ONE process but does NOT serialise them —
    // Vitest still interleaves files' async hooks/tests on the event loop, so
    // multiple files hit the shared DB at once and race on global constraints
    // (uq_RA_principal isn't systemId-scoped) and shared tables (ContextAlgorithms),
    // which made the full suite flaky while each file passed alone. Files must run
    // strictly one at a time against the single shared DB.
    fileParallelism: false,
    // Container startup + migrations take ~30-60s; allow enough headroom.
    testTimeout: 30000,
    hookTimeout: 120000,
    // Coverage is opt-in via `--coverage` (kept off for normal local runs).
    // Output goes to its own dir so the docs pipeline (coverage.yml) can feed
    // BOTH this lcov and the unit lcov to ReportGenerator, which merges them
    // into one API coverage report. Same include/exclude as the unit config so
    // the two measure the same file set.
    coverage: {
      provider: 'v8',
      reporter: ['lcov'],
      reportsDirectory: './coverage-contract',
      include: ['src/**/*.js'],
      exclude: ['src/**/*.test.js', 'src/index.js'],
    },
  },
});
