import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the account-linking mutation run (stryker.accountlinking.config.json).
//
// Narrow include, same reason as the sibling stryker vitest configs: Stryker copies app/api
// into a temp sandbox, so a test that reads the real filesystem or the crawler manifests at
// ../../tools/crawlers resolves a path that does not exist there, fails the dry run, and
// aborts the whole run before a single mutant is evaluated.
//
// Narrow include rather than a growing exclude list: an excluded test that happened to be
// some mutant's only killer would surface as a false survivor, which is worse than
// measuring less.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/accountlinking/**/*.test.js'],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
