// GENERATED from stryker.matrix.config.json by `npm run mutation-scopes:generate`
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
      'src/lib/resourceVisibility.test.js',
      'src/lib/extKeys.test.js',
      'src/routes/buildFilterWhere.test.js',
      'src/nlreports/extFields.test.js',
      'src/matrix/**/*.test.js',
      'src/routes/matrix/**/*.test.js',
      'src/routes/matrix.*.test.js',
      'src/routes/resources.test.js',
      'src/routes/resources/**/*.test.js',
      'src/routes/permissions/**/*.test.js',
      'src/db/valueCache.test.js',
      'src/lib/attributeLabels.test.js',
      'src/routes/attributeLabels.test.js',
      'src/routes/attributeLabelChannel.test.js',
      'src/ingest/viewRefresh.test.js',
      'src/routes/ingest.coverage.test.js',
      'src/routes/ingest.classify.test.js',
      'src/lib/entitySearch.test.js',
      'src/lib/entitySearch.migration.test.js',
      'src/routes/tags.coverage.test.js',
      'src/routes/identities/listQuery.test.js',
      'src/routes/contexts.coverage.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
