// GENERATED from stryker.nlreports.config.json by `npm run mutation-scopes:generate`
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
      'src/nlreports/sentinels.test.js',
      'src/routes/nlReports.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
