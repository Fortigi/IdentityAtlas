// GENERATED from stryker.adjusttree.config.json by `npm run mutation-scopes:generate`
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
      'src/contexts/adjustments/*.test.js',
      'src/contexts/plugins/manager-hierarchy.layout.test.js',
      'src/contexts/plugins/manager-hierarchy.test.js',
      'src/contexts/plugins/manager-hierarchy.population.test.js',
      'src/contexts/plugins/treeSettings.test.js',
      'src/routes/contexts/trees.test.js',
      'src/db/migrations/104_context_tree_adjustments.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
