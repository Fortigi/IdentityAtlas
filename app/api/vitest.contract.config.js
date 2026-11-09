// Vitest config for contract tests — runs against a real PostgreSQL container.
// Kept separate from vitest.config.js so normal `npm test` stays fast.
// Run with: npm run test:contract

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';
import { CONTRACT_WORKERS } from './test-utils/contractWorkerDb.js';

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
    // One container, one migrated database CLONED PER WORKER (contractWorkerDb.js);
    // this setupFile points each worker's CONTRACT_DB_URL at its own clone.
    //
    // Files must never share a database while running: they race on global
    // constraints (uq_RA_principal isn't systemId-scoped) and shared tables
    // (ContextAlgorithms), which made the suite flaky while each file passed alone.
    // That used to be solved by running the whole suite one file at a time on one
    // database (~111 s in CI). Now each worker runs its files one at a time on ITS
    // OWN database — the same sequential guarantee per database, four at once.
    setupFiles: ['./test-utils/contractWorkerSetup.js'],
    pool: 'forks',
    maxWorkers: CONTRACT_WORKERS,
    fileParallelism: true,
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
