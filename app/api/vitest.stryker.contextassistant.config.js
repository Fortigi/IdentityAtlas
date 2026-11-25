// GENERATED from stryker.contextassistant.config.json by `npm run mutation-scopes:generate`
// (app/api). Do not edit: that file's `tests` list is the one declaration of what
// runs against its `mutate` list, and its `tests_comment` says why.
//
// A narrow include, not a growing exclude list: Stryker runs in a sandbox copy of
// app/api, where a test reading files outside it fails the dry run, and an
// excluded test that was some mutant's only killer would read as a false survivor.

import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

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
