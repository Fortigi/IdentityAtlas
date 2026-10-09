import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the organisation-truth mutation run (stryker.orgtruth.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it resolves a path that does not exist there, fails the dry run, and
// aborts the whole run before a single mutant is evaluated.
//
// Every workstream that adds a file to `mutate` adds its killing tests here.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/orgtruth/contracts.test.js',
      'src/orgtruth/linking/run.test.js',
      'src/orgtruth/linking/stats.test.js',
      'src/orgtruth/projection/plugin.test.js',
      'src/routes/orgTruth.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
