import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the interviews mutation run (stryker.interviews.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it resolves a path that does not exist there, fails the dry run, and
// aborts the whole run before a single mutant is evaluated. Every file here stays inside
// app/api (the migration test reads its own sibling .sql, which the sandbox copies).

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/interviews/canonicalWrites.guard.test.js',
      'src/interviews/contextRead.test.js',
      'src/interviews/contracts.test.js',
      'src/interviews/evidence.test.js',
      'src/interviews/resolution.test.js',
      'src/interviews/review.test.js',
      'src/interviews/search.test.js',
      'src/db/migrations/084_interviews.test.js',
      'src/routes/interviews.claims.test.js',
      'src/routes/interviews.lookup.test.js',
      'src/routes/interviews.sessions.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
