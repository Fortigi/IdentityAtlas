import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the effective-access mutation run (stryker.effectiveaccess.config.json).
//
// Narrow include, for the same reason as vitest.stryker.config.js: Stryker copies app/api
// into a temp sandbox, so any test that reads the real filesystem or the crawler manifests
// at ../../tools/crawlers resolves a path that does not exist there, fails the dry run, and
// aborts the whole run before a single mutant is evaluated.
//
// Narrow include rather than a growing exclude list: an excluded test that happened to be
// some mutant's only killer would surface as a false survivor, which is worse than
// measuring less.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/effectiveAccess/**/*.test.js'],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
