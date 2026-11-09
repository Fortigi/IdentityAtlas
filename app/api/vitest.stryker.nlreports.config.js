import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the natural-language reports mutation run (stryker.nlreports.config.json),
// split out of the reports run (#1548). The nlreports tests moved here with the files they test.
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
// here is a real killer for the five mutated files.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/nlreports/compare.test.js',
      'src/nlreports/compile.test.js',
      'src/nlreports/compile.scope.test.js',
      'src/nlreports/scope.test.js',
      'src/nlreports/references.scope.test.js',
      'src/nlreports/extFields.test.js',
      'src/nlreports/llamacpp.test.js',
      'src/nlreports/ollama.test.js',
      'src/nlreports/references.test.js',
      'src/nlreports/savedReports.test.js',
      'src/nlreports/service.test.js',
      'src/nlreports/spec.test.js',
      'src/nlreports/terms.test.js',
      'src/nlreports/service.terms.test.js',
      'src/routes/nlReports.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
