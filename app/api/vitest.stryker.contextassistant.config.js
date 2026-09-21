import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the context-assistant mutation run (stryker.contextassistant.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it resolves a path that does not exist there, fails the dry run, and
// aborts the whole run before a single mutant is evaluated.
//
// Listed instead of excluded: an excluded test that happened to be some mutant's only killer
// would surface as a false survivor, which is worse than measuring less. Every test here is a
// real killer for the mutated files — the recipe language and its plugin, the model-facing
// service, and the routes. nlreports/service.test.js is here for warmup.js, and
// routes/nlReports.test.js for assistantHttp.js: both are shared with custom reports, and
// these are the tests that exercise them.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/contextAssistant/service.test.js',
      'src/contexts/plugins/context-recipe.test.js',
      'src/contexts/recipe/matches.test.js',
      'src/contexts/recipe/recipe.test.js',
      'src/contexts/recipe/relatedWords.test.js',
      'src/nlreports/service.test.js',
      'src/routes/contextAssistant.test.js',
      'src/routes/nlReports.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
