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
    include: ['src/**/*.contract.test.js'],
    globalSetup: ['./test-utils/contractGlobalSetup.js'],
    // Single worker: contract tests share one DB container; parallelism would
    // require per-test isolation that adds complexity. Keep it simple.
    pool: 'forks',
    forks: { singleFork: true },
    // Container startup + migrations take ~30-60s; allow enough headroom.
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
