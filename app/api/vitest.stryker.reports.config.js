import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the reports mutation run (stryker.reports.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it resolves a path that does not exist there, fails the dry run, and
// aborts the whole run before a single mutant is evaluated. Two tests of the reports code
// do exactly that and are therefore left out — reportNames.guard.test.js (it scans app/ui
// as well as app/api) and the contract tests (they need a PostgreSQL container).
//
// Listed instead of excluded: an excluded test that happened to be some mutant's only
// killer would surface as a false survivor, which is worse than measuring less. Every test
// here is a real killer for the four mutated files.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/reports/registry.test.js',
      'src/reports/templates/orphaned-accounts.test.js',
      'src/routes/reports.test.js',
      'src/accountlinking/orphanQuery.test.js',
      'src/contexts/plugins/orphaned-accounts.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
