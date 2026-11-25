// GENERATED from stryker.businessroles.config.json by `npm run mutation-scopes:generate`
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
      'src/lib/businessRoleAccessModel.test.js',
      'src/lib/businessRoleReview.test.js',
      'src/lib/businessRoleOwners.test.js',
      'src/lib/businessRoleOwnerSuggestion.test.js',
      'src/lib/businessRolePeople.test.js',
      'src/routes/details/businessRoleOwners.test.js',
      'src/lib/businessRoleOwnerImport.test.js',
      'src/routes/details/businessRoleOwnerImport.test.js',
      'src/routes/ingest/businessRoleOwners.test.js',
      'src/lib/businessRoleCatalog.test.js',
      'src/lib/businessRoleCompositionReview.test.js',
      'src/lib/businessRoleSnapshot.test.js',
      'src/routes/details/businessRoleCompositionReview.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
